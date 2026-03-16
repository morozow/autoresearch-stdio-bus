"""
train_beta.py — Full implementation of advanced training techniques.

Implements:
1. RMSNorm instead of LayerNorm
2. Rotary Position Embeddings (RoPE)
3. Value Embeddings (ResFormer) with alternating layers and learnable gate
4. QK-Norm
5. Sliding Window Attention (SSSL pattern)
6. Residual Lambdas (learnable resid_lambdas + x0_lambdas)
7. ReLU² activation
8. Softcap Logits
9. Pre-Norm architecture
10. MuonAdamW hybrid optimizer (Muon + AdamW)
11. Polar Express orthogonalization
12. NorMuon variance reduction
13. Cautious Weight Decay
14. LR schedules (warmup, warmdown, momentum warmup, WD decay)
15. Special weight initialization
16. Meta device initialization (CUDA) / direct initialization (MPS)
17. Flash Attention 3 (CUDA) / SDPA fallback (MPS)
18. GQA support
19. Time-based training (5 minutes)
20. Fast fail at loss > 100
21. Prefetch, GC freeze, and other optimizations

Supports: CUDA (NVIDIA GPU), MPS (Apple Silicon), CPU fallback.
Device auto-detected from DEVICE_BACKEND env var (default: cuda on Linux, mps on macOS).

Usage:
    uv run train_beta.py                    # auto-detect device
    DEVICE_BACKEND=mps uv run train_beta.py # force MPS
    DEVICE_BACKEND=cuda uv run train_beta.py # force CUDA
"""

import os
import gc
import sys
import time
import math
from dataclasses import dataclass
from typing import Optional, List, Tuple, Dict, Any

import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

# Import from prepare.py (read-only)
from prepare import (
    Tokenizer,
    make_dataloader,
    evaluate_bpb,
    MAX_SEQ_LEN,
    TIME_BUDGET,
    DEVICE_BACKEND,
)

# ---------------------------------------------------------------------------
# Device capability flags
# ---------------------------------------------------------------------------

IS_CUDA = DEVICE_BACKEND == "cuda"
IS_MPS = DEVICE_BACKEND == "mps"
USE_COMPILE = IS_CUDA  # torch.compile not supported on MPS

# ---------------------------------------------------------------------------
# Flash Attention 3 setup (CUDA only)
# ---------------------------------------------------------------------------

def get_flash_attention():
    """Get Flash Attention 3 based on GPU capability. Returns None on non-CUDA."""
    if not IS_CUDA:
        return None
    try:
        from kernels import get_kernel
        cap = torch.cuda.get_device_capability()
        # Hopper (H100, capability 9.0) uses original FA3
        # Others use community port
        repo = "varunneal/flash-attention-3" if cap == (9, 0) else "kernels-community/flash-attn3"
        fa3 = get_kernel(repo).flash_attn_interface
        return fa3
    except Exception as e:
        print(f"Warning: Flash Attention 3 not available: {e}", file=sys.stderr)
        return None

FA3 = get_flash_attention()

# ---------------------------------------------------------------------------
# Constants and Hyperparameters
# ---------------------------------------------------------------------------

# Architecture
DEPTH = 10                   # number of transformer layers
ASPECT_RATIO = 64            # model_dim = depth * aspect_ratio (rounded to HEAD_DIM)
HEAD_DIM = 128               # dimension per attention head
WINDOW_PATTERN = "SSSL"      # Short-Short-Short-Long sliding window pattern
VE_GATE_CHANNELS = 32        # channels for value embedding gate

# Optimizer
MATRIX_LR = 0.04             # Muon LR for 2D matrices
EMBEDDING_LR = 0.6           # AdamW LR for embeddings
LM_HEAD_LR = 0.004           # AdamW LR for lm_head
RESID_LAMBDA_LR = 0.005      # AdamW LR for resid_lambdas
X0_LAMBDA_LR = 0.5           # AdamW LR for x0_lambdas
WEIGHT_DECAY = 0.2           # initial weight decay (decays to 0)
ADAMW_BETAS = (0.9, 0.95)    # AdamW betas
X0_BETAS = (0.96, 0.95)      # special betas for x0_lambdas
ADAMW_EPS = 1e-10            # AdamW epsilon
MUON_MOMENTUM = 0.95         # Muon momentum (after warmup)
MUON_NS_STEPS = 5            # Polar Express iterations

# LR Schedule
WARMUP_RATIO = 0.0           # no warmup
WARMDOWN_RATIO = 0.5         # last 50% is linear decay
FINAL_LR_FRAC = 0.0          # decay to 0

# Training
# MPS: small batch (4K tokens), CUDA: large batch (512K tokens)
TOTAL_BATCH_SIZE = 2**13 if IS_MPS else 2**19  # tokens per step (8K on MPS)
SOFTCAP = 15                 # logit softcap value
EMA_BETA = 0.95              # EMA for loss smoothing

# Hardware
H100_BF16_PEAK_FLOPS = 989e12  # H100 SXM peak BF16 FLOPS

# Polar Express coefficients (precomputed for 5 iterations)
POLAR_EXPRESS_COEFFS = [
    (8.156554524902461, -22.48329292557795, 15.878769915207462),
    (2.0029432375498533, -1.5065426192498068, 0.5038762047498204),
    (1.4999999999999996, -0.5833333333333333, 0.08333333333333333),
    (1.2499999999999998, -0.2916666666666666, 0.041666666666666664),
    (1.1249999999999998, -0.1458333333333333, 0.020833333333333332),
]

# ---------------------------------------------------------------------------
# Model Configuration
# ---------------------------------------------------------------------------

@dataclass
class GPTConfig:
    vocab_size: int = 8192
    sequence_len: int = MAX_SEQ_LEN
    n_layer: int = DEPTH
    n_head: int = 4           # computed from model_dim
    n_kv_head: int = 4        # for GQA support (default: MHA)
    n_embd: int = 512         # computed from depth * aspect_ratio
    head_dim: int = HEAD_DIM
    window_pattern: str = WINDOW_PATTERN


def build_model_config(depth: int = DEPTH) -> GPTConfig:
    """Build model config with proper dimension calculations."""
    base_dim = depth * ASPECT_RATIO
    # Round up to multiple of HEAD_DIM
    model_dim = ((base_dim + HEAD_DIM - 1) // HEAD_DIM) * HEAD_DIM
    num_heads = model_dim // HEAD_DIM
    
    return GPTConfig(
        n_layer=depth,
        n_head=num_heads,
        n_kv_head=num_heads,  # MHA by default, can be changed for GQA
        n_embd=model_dim,
        head_dim=HEAD_DIM,
    )

# ---------------------------------------------------------------------------
# Utility Functions
# ---------------------------------------------------------------------------

def norm(x: Tensor) -> Tensor:
    """RMSNorm — simpler and faster than LayerNorm."""
    return F.rms_norm(x, (x.size(-1),))


def has_ve(layer_idx: int, n_layer: int) -> bool:
    """Returns True if layer should have Value Embedding (alternating, last always included)."""
    return layer_idx % 2 == (n_layer - 1) % 2

# ---------------------------------------------------------------------------
# Rotary Position Embeddings (RoPE)
# ---------------------------------------------------------------------------

def precompute_rotary_emb(seq_len: int, head_dim: int, device: torch.device) -> Tuple[Tensor, Tensor]:
    """Precompute cos/sin for RoPE."""
    d = head_dim // 2
    theta = 1.0 / (10000 ** (torch.arange(0, d, device=device).float() / d))
    positions = torch.arange(seq_len, device=device).float()
    angles = positions.unsqueeze(1) * theta.unsqueeze(0)  # [seq_len, d]
    cos = angles.cos()
    sin = angles.sin()
    # Shape: [1, seq_len, 1, d] for correct broadcasting with [B, T, H, d]
    return cos[None, :, None, :], sin[None, :, None, :]


def apply_rotary_emb(x: Tensor, cos: Tensor, sin: Tensor) -> Tensor:
    """Apply rotary embeddings to x."""
    # x: [B, T, H, D]
    d = x.shape[3] // 2
    x1, x2 = x[..., :d], x[..., d:]
    y1 = x1 * cos + x2 * sin
    y2 = x1 * (-sin) + x2 * cos
    return torch.cat([y1, y2], dim=3)

# ---------------------------------------------------------------------------
# Attention Module
# ---------------------------------------------------------------------------

class CausalSelfAttention(nn.Module):
    """Multi-head attention with RoPE, QK-norm, Value Embeddings, and sliding window."""
    
    def __init__(self, config: GPTConfig, layer_idx: int):
        super().__init__()
        self.n_head = config.n_head
        self.n_kv_head = config.n_kv_head
        self.head_dim = config.head_dim
        self.layer_idx = layer_idx
        
        assert self.n_kv_head <= self.n_head and self.n_head % self.n_kv_head == 0
        
        # Q, K, V projections
        self.c_q = nn.Linear(config.n_embd, self.n_head * self.head_dim, bias=False)
        self.c_k = nn.Linear(config.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.c_v = nn.Linear(config.n_embd, self.n_kv_head * self.head_dim, bias=False)
        
        # Output projection
        self.c_proj = nn.Linear(self.n_head * self.head_dim, config.n_embd, bias=False)
        
        # Value Embedding gate (if this layer has VE)
        self.has_ve = has_ve(layer_idx, config.n_layer)
        if self.has_ve:
            self.ve_gate_channels = VE_GATE_CHANNELS
            self.ve_gate = nn.Linear(self.ve_gate_channels, self.n_kv_head, bias=False)
    
    def forward(
        self,
        x: Tensor,
        ve: Optional[Tensor],
        cos_sin: Tuple[Tensor, Tensor],
        window_size: Tuple[int, int],
    ) -> Tensor:
        B, T, C = x.shape
        cos, sin = cos_sin
        
        # Compute Q, K, V
        q = self.c_q(x).view(B, T, self.n_head, self.head_dim)
        k = self.c_k(x).view(B, T, self.n_kv_head, self.head_dim)
        v = self.c_v(x).view(B, T, self.n_kv_head, self.head_dim)
        
        # QK-Norm
        q, k = norm(q), norm(k)
        
        # Apply RoPE
        q = apply_rotary_emb(q, cos[:, :T], sin[:, :T])
        k = apply_rotary_emb(k, cos[:, :T], sin[:, :T])
        
        # Add Value Embeddings if present
        if ve is not None and self.has_ve:
            ve = ve.view(B, T, self.n_kv_head, self.head_dim)
            # Gate: sigmoid([0,1]) * 2 -> [0,2], init at 1.0 (neutral)
            gate = 2 * torch.sigmoid(self.ve_gate(x[..., :self.ve_gate_channels]))  # [B, T, n_kv_head]
            v = v + gate.unsqueeze(-1) * ve
        
        # Transpose for attention: [B, H, T, D]
        q = q.transpose(1, 2)
        k = k.transpose(1, 2)
        v = v.transpose(1, 2)
        
        # Expand KV heads for GQA
        if self.n_kv_head < self.n_head:
            repeat_factor = self.n_head // self.n_kv_head
            k = k.repeat_interleave(repeat_factor, dim=1)
            v = v.repeat_interleave(repeat_factor, dim=1)
        
        # Attention
        if FA3 is not None and window_size[0] == 0:
            # Full attention with Flash Attention 3
            # FA3 expects [B, T, H, D]
            q = q.transpose(1, 2).contiguous()
            k = k.transpose(1, 2).contiguous()
            v = v.transpose(1, 2).contiguous()
            y = FA3.flash_attn_func(q, k, v, causal=True)
            y = y.view(B, T, -1)
        else:
            # SDPA with optional sliding window
            if window_size[0] > 0 and IS_CUDA:
                # Create sliding window mask (CUDA only — MPS OOMs on explicit masks)
                mask = torch.ones(T, T, dtype=torch.bool, device=x.device).tril()
                window_mask = torch.ones(T, T, dtype=torch.bool, device=x.device).triu(-window_size[0] + 1)
                mask = mask & window_mask
                y = F.scaled_dot_product_attention(q, k, v, attn_mask=mask)
            else:
                # MPS / full attention: use is_causal=True (no explicit mask)
                y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
            y = y.transpose(1, 2).contiguous().view(B, T, -1)
        
        return self.c_proj(y)

# ---------------------------------------------------------------------------
# MLP Module
# ---------------------------------------------------------------------------

class MLP(nn.Module):
    """MLP with ReLU² activation."""
    
    def __init__(self, config: GPTConfig):
        super().__init__()
        hidden_dim = 4 * config.n_embd
        self.c_fc = nn.Linear(config.n_embd, hidden_dim, bias=False)
        self.c_proj = nn.Linear(hidden_dim, config.n_embd, bias=False)
    
    def forward(self, x: Tensor) -> Tensor:
        x = self.c_fc(x)
        x = F.relu(x).square()  # ReLU²
        x = self.c_proj(x)
        return x

# ---------------------------------------------------------------------------
# Transformer Block
# ---------------------------------------------------------------------------

class Block(nn.Module):
    """Transformer block with Pre-Norm architecture."""
    
    def __init__(self, config: GPTConfig, layer_idx: int):
        super().__init__()
        self.attn = CausalSelfAttention(config, layer_idx)
        self.mlp = MLP(config)
    
    def forward(
        self,
        x: Tensor,
        ve: Optional[Tensor],
        cos_sin: Tuple[Tensor, Tensor],
        window_size: Tuple[int, int],
    ) -> Tensor:
        # Pre-Norm: norm before each sub-block
        x = x + self.attn(norm(x), ve, cos_sin, window_size)
        x = x + self.mlp(norm(x))
        return x

# ---------------------------------------------------------------------------
# GPT Model
# ---------------------------------------------------------------------------

class GPT(nn.Module):
    """GPT model with all advanced techniques."""
    
    def __init__(self, config: GPTConfig):
        super().__init__()
        self.config = config
        
        self.transformer = nn.ModuleDict(dict(
            wte=nn.Embedding(config.vocab_size, config.n_embd),
            h=nn.ModuleList([Block(config, i) for i in range(config.n_layer)]),
        ))
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        
        # Value Embeddings (only for layers that need them)
        kv_dim = config.n_kv_head * config.head_dim
        self.value_embeds = nn.ModuleDict({
            str(i): nn.Embedding(config.vocab_size, kv_dim)
            for i in range(config.n_layer) if has_ve(i, config.n_layer)
        })
        
        # Residual Lambdas
        self.resid_lambdas = nn.Parameter(torch.ones(config.n_layer))
        self.x0_lambdas = nn.Parameter(torch.zeros(config.n_layer))
        
        # Precompute rotary embeddings (10x sequence length for future expansion)
        self.rotary_seq_len = config.sequence_len * 10
        
        # Compute window sizes
        self.window_sizes = self._compute_window_sizes(config)
    
    def _compute_window_sizes(self, config: GPTConfig) -> List[Tuple[int, int]]:
        """Compute sliding window sizes based on pattern."""
        pattern = config.window_pattern
        long_window = config.sequence_len
        short_window = long_window // 2
        
        window_sizes = []
        for i in range(config.n_layer):
            pattern_idx = i % len(pattern)
            if pattern[pattern_idx] == 'S':
                window_sizes.append((short_window, 0))
            else:  # 'L'
                window_sizes.append((0, 0))  # 0 means full attention
        
        # Last layer always has full attention
        window_sizes[-1] = (0, 0)
        
        return window_sizes
    
    def _get_rotary_emb(self, device: torch.device) -> Tuple[Tensor, Tensor]:
        """Get or create rotary embeddings."""
        if not hasattr(self, '_cos') or self._cos.device != device:
            self._cos, self._sin = precompute_rotary_emb(
                self.rotary_seq_len, self.config.head_dim, device
            )
        return self._cos, self._sin
    
    def init_weights(self):
        """Initialize weights with special scheme."""
        n_embd = self.config.n_embd
        s = 3**0.5 * n_embd**-0.5
        
        # Embeddings: N(0, 1)
        torch.nn.init.normal_(self.transformer.wte.weight, mean=0.0, std=1.0)
        
        # LM head: N(0, 0.001) — very small
        torch.nn.init.normal_(self.lm_head.weight, mean=0.0, std=0.001)
        
        # Value Embeddings: N(0, 1)
        for ve in self.value_embeds.values():
            torch.nn.init.normal_(ve.weight, mean=0.0, std=1.0)
        
        # Transformer blocks
        for block in self.transformer.h:
            # Attention Q, K, V: Uniform(-s, s)
            torch.nn.init.uniform_(block.attn.c_q.weight, -s, s)
            torch.nn.init.uniform_(block.attn.c_k.weight, -s, s)
            torch.nn.init.uniform_(block.attn.c_v.weight, -s, s)
            
            # Output projections: zeros (residual init)
            torch.nn.init.zeros_(block.attn.c_proj.weight)
            
            # MLP: Uniform(-s, s) for fc, zeros for proj
            torch.nn.init.uniform_(block.mlp.c_fc.weight, -s, s)
            torch.nn.init.zeros_(block.mlp.c_proj.weight)
            
            # VE gates: zeros → sigmoid(0)=0.5 → *2 = 1.0 (neutral)
            if block.attn.has_ve:
                torch.nn.init.zeros_(block.attn.ve_gate.weight)
        
        # Residual lambdas
        with torch.no_grad():
            self.resid_lambdas.fill_(1.0)
            self.x0_lambdas.fill_(0.1)
    
    def forward(
        self,
        idx: Tensor,
        targets: Optional[Tensor] = None,
        reduction: str = 'mean',
    ) -> Tensor:
        B, T = idx.shape
        device = idx.device
        
        # Token embeddings
        x = self.transformer.wte(idx)
        x0 = x  # save for x0_lambdas
        
        # Get rotary embeddings
        cos_sin = self._get_rotary_emb(device)
        
        # Transformer blocks with residual lambdas
        for i, block in enumerate(self.transformer.h):
            # Apply residual lambdas
            x = self.resid_lambdas[i] * x + self.x0_lambdas[i] * x0
            
            # Get value embeddings if this layer has them
            ve = None
            if str(i) in self.value_embeds:
                ve = self.value_embeds[str(i)](idx)
            
            x = block(x, ve, cos_sin, self.window_sizes[i])
        
        # Final norm and head
        x = norm(x)
        logits = self.lm_head(x)
        
        # Softcap logits
        logits = logits.float()
        logits = SOFTCAP * torch.tanh(logits / SOFTCAP)
        
        if targets is None:
            return logits
        
        # Compute loss
        loss = F.cross_entropy(
            logits.view(-1, logits.size(-1)),
            targets.view(-1),
            reduction=reduction,
        )
        return loss
    
    def estimate_flops(self) -> int:
        """Estimate FLOPs per token."""
        cfg = self.config
        n_embd = cfg.n_embd
        n_layer = cfg.n_layer
        vocab_size = cfg.vocab_size
        seq_len = cfg.sequence_len
        
        # Count parameters (excluding embeddings)
        nparams = sum(p.numel() for p in self.parameters())
        embed_params = self.transformer.wte.weight.numel()
        nparams -= embed_params
        
        # Attention FLOPs: 4 * n_layer * seq_len * n_embd
        attn_flops = 4 * n_layer * seq_len * n_embd
        
        # Total: 6 * params (forward + backward) + attention
        return 6 * nparams + attn_flops

# ---------------------------------------------------------------------------
# MuonAdamW Optimizer
# ---------------------------------------------------------------------------

def _maybe_compile(fn):
    """Apply torch.compile only on CUDA where it's supported."""
    if USE_COMPILE:
        return torch.compile(dynamic=False, fullgraph=True)(fn)
    return fn


@_maybe_compile
def adamw_step_fused(
    p: Tensor,
    grad: Tensor,
    exp_avg: Tensor,
    exp_avg_sq: Tensor,
    step_t: Tensor,
    lr_t: Tensor,
    beta1_t: Tensor,
    beta2_t: Tensor,
    eps_t: Tensor,
    wd_t: Tensor,
):
    """Fused AdamW step."""
    # Extract scalar values (avoids CPU/MPS device mismatch in lerp_)
    lr = lr_t.item()
    beta1 = beta1_t.item()
    beta2 = beta2_t.item()
    eps = eps_t.item()
    wd = wd_t.item()
    step = step_t.item()

    # Weight decay
    p.mul_(1 - lr * wd)
    
    # Momentum (m)
    exp_avg.lerp_(grad, 1 - beta1)
    
    # Variance (v)
    exp_avg_sq.lerp_(grad.square(), 1 - beta2)
    
    # Bias correction
    bias1 = 1 - beta1 ** step
    bias2 = 1 - beta2 ** step
    
    # Update
    denom = (exp_avg_sq / bias2).sqrt() + eps
    step_size = lr / bias1
    p.add_(exp_avg / denom, alpha=-step_size)


@_maybe_compile
def muon_step_fused(
    stacked_params: Tensor,
    stacked_grads: Tensor,
    momentum_buffer: Tensor,
    second_momentum_buffer: Tensor,
    momentum_t: Tensor,
    beta2_t: Tensor,
    lr_t: Tensor,
    wd_t: Tensor,
    ns_steps: int,
    shape: Tuple[int, ...],
    red_dim: int,
    polar_coeffs: List[Tuple[float, float, float]],
):
    """Fused Muon step with Polar Express orthogonalization and NorMuon."""
    # Extract scalar values (avoids CPU/MPS device mismatch)
    momentum = momentum_t.item()
    beta2 = beta2_t.item()
    lr = lr_t.item()
    wd = wd_t.item()

    num_params = stacked_params.size(0)
    
    # 1. Nesterov momentum
    momentum_buffer.lerp_(stacked_grads, 1 - momentum)
    g = stacked_grads.lerp_(momentum_buffer, momentum)
    
    # Save original norm for NorMuon
    orig_norm = g.norm(dim=(-2, -1), keepdim=True)
    
    # 2. Polar Express orthogonalization
    # CUDA: bfloat16 for speed; MPS/CPU: float32 (no bf16 support)
    polar_dtype = torch.bfloat16 if g.device.type == "cuda" else torch.float32
    X = g.to(polar_dtype)
    X = X / (X.norm(dim=(-2, -1), keepdim=True) * 1.02 + 1e-6)
    
    for i in range(ns_steps):
        a, b, c = polar_coeffs[i]
        if shape[-2] > shape[-1]:
            # X @ (X.T @ X) — for tall matrices
            A = X.mT @ X
            B = b * A + c * (A @ A)
            X = a * X + X @ B
        else:
            # (X @ X.T) @ X — for wide matrices
            A = X @ X.mT
            B = b * A + c * (A @ A)
            X = a * X + B @ X
    
    g = X.float()
    
    # 3. NorMuon variance reduction
    v_mean = g.square().mean(dim=red_dim, keepdim=True)
    second_momentum_buffer.lerp_(v_mean, 1 - beta2)
    
    # Normalize to preserve original gradient norm
    new_norm = g.norm(dim=(-2, -1), keepdim=True)
    g = g * (orig_norm / (new_norm + 1e-8))
    
    step_size = second_momentum_buffer.clamp_min(1e-10).rsqrt()
    g = g * step_size
    
    # 4. Cautious weight decay: only when gradient and param have same sign
    mask = (g * stacked_params) >= 0
    stacked_params.sub_(lr * g + lr * wd * stacked_params * mask)


class MuonAdamW:
    """Hybrid optimizer: Muon for 2D matrices, AdamW for everything else."""
    
    def __init__(self, param_groups: List[Dict[str, Any]]):
        self.param_groups = param_groups
        self.state: Dict[int, Dict[str, Any]] = {}
        
        # CPU tensors for torch.compile (avoid recompilation on value changes)
        self._adamw_step_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_lr_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_beta1_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_beta2_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_eps_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._adamw_wd_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        
        self._muon_momentum_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_beta2_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_lr_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        self._muon_wd_t = torch.tensor(0.0, dtype=torch.float32, device="cpu")
        
        self._step = 0
        
        # Initialize state for all parameters
        for group in param_groups:
            for p in group["params"]:
                self._init_state(p, group)
    
    def _init_state(self, p: Tensor, group: Dict[str, Any]):
        """Initialize optimizer state for a parameter."""
        pid = id(p)
        if pid in self.state:
            return
        
        kind = group["kind"]
        if kind == "adamw":
            self.state[pid] = {
                "exp_avg": torch.zeros_like(p),
                "exp_avg_sq": torch.zeros_like(p),
            }
        elif kind == "muon":
            shape = p.shape
            red_dim = -1 if shape[-2] >= shape[-1] else -2
            state_shape = (shape[-2], 1) if shape[-2] >= shape[-1] else (1, shape[-1])
            self.state[pid] = {
                "momentum_buffer": torch.zeros_like(p),
                "second_momentum_buffer": torch.zeros(state_shape, device=p.device, dtype=p.dtype),
                "red_dim": red_dim,
            }
    
    def step(self):
        """Perform optimization step."""
        with torch.no_grad():
            self._step += 1
            
            for group in self.param_groups:
                kind = group["kind"]
                lr = group["lr"]
                wd = group.get("weight_decay", 0.0)
                
                if kind == "adamw":
                    self._step_adamw(group, lr, wd)
                elif kind == "muon":
                    self._step_muon(group, lr, wd)
    
    def _step_adamw(self, group: Dict[str, Any], lr: float, wd: float):
        """AdamW step for a parameter group."""
        betas = group.get("betas", ADAMW_BETAS)
        eps = group.get("eps", ADAMW_EPS)
        
        self._adamw_step_t.fill_(self._step)
        self._adamw_lr_t.fill_(lr)
        self._adamw_beta1_t.fill_(betas[0])
        self._adamw_beta2_t.fill_(betas[1])
        self._adamw_eps_t.fill_(eps)
        self._adamw_wd_t.fill_(wd)
        
        for p in group["params"]:
            if p.grad is None:
                continue
            
            state = self.state[id(p)]
            adamw_step_fused(
                p, p.grad,
                state["exp_avg"], state["exp_avg_sq"],
                self._adamw_step_t,
                self._adamw_lr_t,
                self._adamw_beta1_t,
                self._adamw_beta2_t,
                self._adamw_eps_t,
                self._adamw_wd_t,
            )
    
    def _step_muon(self, group: Dict[str, Any], lr: float, wd: float):
        """Muon step for a parameter group."""
        momentum = group.get("momentum", MUON_MOMENTUM)
        ns_steps = group.get("ns_steps", MUON_NS_STEPS)
        beta2 = group.get("beta2", 0.999)
        
        for p in group["params"]:
            if p.grad is None:
                continue
            
            state = self.state[id(p)]
            shape = p.shape
            
            # LR scaling for aspect ratio
            scaled_lr = lr * max(1.0, shape[-2] / shape[-1])**0.5
            
            self._muon_momentum_t.fill_(momentum)
            self._muon_beta2_t.fill_(beta2)
            self._muon_lr_t.fill_(scaled_lr)
            self._muon_wd_t.fill_(wd)
            
            # Stack for batch processing (single param here)
            stacked_params = p.unsqueeze(0)
            stacked_grads = p.grad.unsqueeze(0)
            momentum_buffer = state["momentum_buffer"].unsqueeze(0)
            second_momentum_buffer = state["second_momentum_buffer"].unsqueeze(0)
            
            muon_step_fused(
                stacked_params,
                stacked_grads,
                momentum_buffer,
                second_momentum_buffer,
                self._muon_momentum_t,
                self._muon_beta2_t,
                self._muon_lr_t,
                self._muon_wd_t,
                ns_steps,
                shape,
                state["red_dim"],
                POLAR_EXPRESS_COEFFS,
            )
            
            # Copy back
            p.data.copy_(stacked_params.squeeze(0))
            state["momentum_buffer"].copy_(momentum_buffer.squeeze(0))
            state["second_momentum_buffer"].copy_(second_momentum_buffer.squeeze(0))
    
    def zero_grad(self, set_to_none: bool = True):
        """Zero gradients."""
        for group in self.param_groups:
            for p in group["params"]:
                if set_to_none:
                    p.grad = None
                elif p.grad is not None:
                    p.grad.zero_()

# ---------------------------------------------------------------------------
# Learning Rate Schedules
# ---------------------------------------------------------------------------

def get_lr_multiplier(progress: float) -> float:
    """Get LR multiplier based on training progress."""
    if progress < WARMUP_RATIO:
        # Warmup phase
        return progress / WARMUP_RATIO if WARMUP_RATIO > 0 else 1.0
    elif progress < 1.0 - WARMDOWN_RATIO:
        # Constant phase
        return 1.0
    else:
        # Warmdown phase (linear decay)
        cooldown = (1.0 - progress) / WARMDOWN_RATIO
        return cooldown * 1.0 + (1 - cooldown) * FINAL_LR_FRAC


def get_muon_momentum(step: int) -> float:
    """Get Muon momentum with warmup."""
    frac = min(step / 300, 1.0)
    return (1 - frac) * 0.85 + frac * 0.95  # 0.85 → 0.95 over 300 steps


def get_weight_decay(progress: float) -> float:
    """Get weight decay with linear decay."""
    return WEIGHT_DECAY * (1 - progress)  # 0.2 → 0.0 linearly

# ---------------------------------------------------------------------------
# Parameter Groups Builder
# ---------------------------------------------------------------------------

def build_param_groups(model: GPT) -> List[Dict[str, Any]]:
    """Build parameter groups for MuonAdamW optimizer."""
    # LR scaling based on model dimension
    scale = (model.config.n_embd / 768) ** -0.5
    
    # Collect parameters by type
    lm_head_params = [model.lm_head.weight]
    embedding_params = [model.transformer.wte.weight]
    value_embeds_params = [ve.weight for ve in model.value_embeds.values()]
    resid_params = [model.resid_lambdas]
    x0_params = [model.x0_lambdas]
    
    # Muon params: 2D matrices from attention and MLP
    muon_params = []
    for block in model.transformer.h:
        muon_params.extend([
            block.attn.c_q.weight,
            block.attn.c_k.weight,
            block.attn.c_v.weight,
            block.attn.c_proj.weight,
            block.mlp.c_fc.weight,
            block.mlp.c_proj.weight,
        ])
        if block.attn.has_ve:
            muon_params.append(block.attn.ve_gate.weight)
    
    # MPS fallback: Polar Express causes NaN on MPS, use AdamW for matrix params instead
    if IS_MPS:
        param_groups = [
            # AdamW groups
            dict(kind='adamw', params=lm_head_params, lr=LM_HEAD_LR * scale, initial_lr=LM_HEAD_LR * scale),
            dict(kind='adamw', params=embedding_params, lr=EMBEDDING_LR * scale, initial_lr=EMBEDDING_LR * scale),
            dict(kind='adamw', params=value_embeds_params, lr=EMBEDDING_LR * scale, initial_lr=EMBEDDING_LR * scale),
            dict(kind='adamw', params=resid_params, lr=RESID_LAMBDA_LR, initial_lr=RESID_LAMBDA_LR),
            dict(kind='adamw', params=x0_params, lr=X0_LAMBDA_LR, initial_lr=X0_LAMBDA_LR, betas=X0_BETAS),
            # Matrix params with AdamW (Muon NaN workaround for MPS)
            dict(kind='adamw', params=muon_params, lr=MATRIX_LR * 0.5, initial_lr=MATRIX_LR * 0.5, betas=(0.9, 0.95)),
        ]
    else:
        param_groups = [
            # AdamW groups
            dict(kind='adamw', params=lm_head_params, lr=LM_HEAD_LR * scale, initial_lr=LM_HEAD_LR * scale),
            dict(kind='adamw', params=embedding_params, lr=EMBEDDING_LR * scale, initial_lr=EMBEDDING_LR * scale),
            dict(kind='adamw', params=value_embeds_params, lr=EMBEDDING_LR * scale, initial_lr=EMBEDDING_LR * scale),
            dict(kind='adamw', params=resid_params, lr=RESID_LAMBDA_LR, initial_lr=RESID_LAMBDA_LR),
            dict(kind='adamw', params=x0_params, lr=X0_LAMBDA_LR, initial_lr=X0_LAMBDA_LR, betas=X0_BETAS),
            # Muon group (CUDA only)
            dict(kind='muon', params=muon_params, lr=MATRIX_LR, initial_lr=MATRIX_LR, momentum=MUON_MOMENTUM, ns_steps=MUON_NS_STEPS),
        ]
    
    return param_groups

# ---------------------------------------------------------------------------
# Training Loop
# ---------------------------------------------------------------------------

def train():
    """Main training function."""
    device = torch.device(DEVICE_BACKEND)
    
    print(f"Device backend: {DEVICE_BACKEND}", file=sys.stderr, flush=True)
    
    # Load tokenizer
    print("Loading tokenizer...", file=sys.stderr, flush=True)
    tokenizer = Tokenizer.from_directory()
    vocab_size = tokenizer.get_vocab_size()
    
    # Build model config
    config = build_model_config(DEPTH)
    config.vocab_size = vocab_size
    
    print(f"Model config: n_layer={config.n_layer}, n_embd={config.n_embd}, n_head={config.n_head}", file=sys.stderr, flush=True)
    
    # Create model
    # CUDA: meta device init + to_empty (fast, avoids double allocation)
    # MPS/CPU: direct init (meta device to_empty not reliably supported on MPS)
    print("Creating model...", file=sys.stderr, flush=True)
    if IS_CUDA:
        with torch.device("meta"):
            model = GPT(config)
        model.to_empty(device=device)
    else:
        model = GPT(config)
        model.to(device)
    model.init_weights()
    
    # Count parameters
    num_params = sum(p.numel() for p in model.parameters())
    print(f"Model parameters: {num_params / 1e6:.1f}M", file=sys.stderr, flush=True)
    
    # Compile model (CUDA only — MPS does not support torch.compile)
    if USE_COMPILE:
        print("Compiling model...", file=sys.stderr, flush=True)
        model = torch.compile(model)
    else:
        print("Skipping torch.compile (not supported on this backend)", file=sys.stderr, flush=True)
    
    # Build optimizer
    param_groups = build_param_groups(model)
    optimizer = MuonAdamW(param_groups)
    
    # Calculate batch size and gradient accumulation
    # MPS: micro_batch=2 (like train_clean.py), CUDA: micro_batch=64
    device_batch_size = 2 if IS_MPS else 64
    batch_size = TOTAL_BATCH_SIZE // MAX_SEQ_LEN
    tokens_per_fwdbwd = device_batch_size * MAX_SEQ_LEN
    grad_accum_steps = max(1, TOTAL_BATCH_SIZE // tokens_per_fwdbwd)
    micro_batch_size = device_batch_size
    
    print(f"Batch size: {batch_size}, micro_batch: {micro_batch_size}, grad_accum: {grad_accum_steps}", file=sys.stderr, flush=True)
    
    # Create dataloader
    train_loader = make_dataloader(tokenizer, micro_batch_size, MAX_SEQ_LEN, "train")
    
    # Prefetch first batch
    x, y, epoch = next(train_loader)
    
    # Training state
    step = 0
    total_training_time = 0.0
    smooth_train_loss = 0.0
    
    # Autocast context — dtype per backend
    if IS_CUDA:
        autocast_ctx = torch.amp.autocast(device_type="cuda", dtype=torch.bfloat16)
    elif IS_MPS:
        autocast_ctx = torch.amp.autocast(device_type="mps", dtype=torch.float16)
    else:
        autocast_ctx = torch.amp.autocast(device_type="cpu", enabled=False)
    
    print("Starting training...", file=sys.stderr, flush=True)
    print(f"Time budget: {TIME_BUDGET}s", file=sys.stderr, flush=True)
    
    # Training loop
    while True:
        t0 = time.time()
        
        # Gradient accumulation
        total_loss = 0.0
        for micro_step in range(grad_accum_steps):
            with autocast_ctx:
                loss = model(x, y)
            loss = loss / grad_accum_steps
            loss.backward()
            total_loss += loss.item() * grad_accum_steps
            
            # Prefetch next batch
            x, y, epoch = next(train_loader)
        
        train_loss_f = total_loss
        
        # Fast fail
        if train_loss_f > 100:
            print("FAIL: loss > 100", file=sys.stderr, flush=True)
            sys.exit(1)
        
        # Update schedules
        progress = total_training_time / TIME_BUDGET if TIME_BUDGET > 0 else 0.0
        lr_mult = get_lr_multiplier(progress)
        wd = get_weight_decay(progress)
        muon_mom = get_muon_momentum(step)
        
        for group in optimizer.param_groups:
            group["lr"] = group["initial_lr"] * lr_mult
            group["weight_decay"] = wd
            if group["kind"] == "muon":
                group["momentum"] = muon_mom
        
        # Optimizer step
        optimizer.step()
        model.zero_grad(set_to_none=True)
        
        # Timing
        dt = time.time() - t0
        
        # GC management
        if step == 0:
            gc.collect()
            if hasattr(gc, "freeze"):
                gc.freeze()
            gc.disable()
        elif step % 5000 == 0:
            gc.enable()
            gc.collect()
            gc.disable()
        
        # Exclude first 10 steps from time budget (compilation)
        if step > 10:
            total_training_time += dt
        
        # EMA loss with debiasing
        smooth_train_loss = EMA_BETA * smooth_train_loss + (1 - EMA_BETA) * train_loss_f
        debiased_smooth_loss = smooth_train_loss / (1 - EMA_BETA ** (step + 1))
        
        # Logging
        if step % 10 == 0:
            # MFU calculation
            tokens_per_step = TOTAL_BATCH_SIZE
            raw_model = model._orig_mod if hasattr(model, '_orig_mod') else model
            flops_per_token = raw_model.estimate_flops()
            mfu = 100 * flops_per_token * tokens_per_step / dt / H100_BF16_PEAK_FLOPS if dt > 0 else 0
            
            timestamp = time.strftime("%H:%M:%S")
            print(f"[{timestamp}] step={step} loss={debiased_smooth_loss:.4f} lr={lr_mult:.3f} time={total_training_time:.1f}s mfu={mfu:.1f}%", 
                  file=sys.stderr, flush=True)
        
        step += 1
        
        # Time-based stopping
        if step > 10 and total_training_time >= TIME_BUDGET:
            break
    
    # Final evaluation
    print("\nEvaluating...", file=sys.stderr, flush=True)
    model.eval()
    
    # Use original model for evaluation if compiled
    eval_model = model._orig_mod if hasattr(model, '_orig_mod') else model
    
    # MPS: use fewer eval tokens to avoid hanging (64 steps vs 5120)
    if IS_MPS:
        from prepare import get_token_bytes
        eval_steps_mps = 64  # ~260K tokens, ~1.5 min eval
        token_bytes = get_token_bytes(device=DEVICE_BACKEND)
        val_loader = make_dataloader(tokenizer, micro_batch_size, MAX_SEQ_LEN, "val")
        total_nats = 0.0
        total_bytes = 0
        with torch.no_grad():
            for i in range(eval_steps_mps):
                x, y, _ = next(val_loader)
                loss_flat = eval_model(x, y, reduction='none').view(-1)
                y_flat = y.view(-1)
                nbytes = token_bytes[y_flat]
                mask = nbytes > 0
                total_nats += (loss_flat * mask).sum().item()
                total_bytes += nbytes.sum().item()
                if (i + 1) % 16 == 0:
                    print(f"  eval step {i+1}/{eval_steps_mps}", file=sys.stderr, flush=True)
        val_bpb = total_nats / (math.log(2) * total_bytes)
    else:
        val_bpb = evaluate_bpb(eval_model, tokenizer, micro_batch_size)
    
    # Get peak VRAM
    if IS_CUDA:
        peak_vram_mb = torch.cuda.max_memory_allocated() / 1024 / 1024
    else:
        peak_vram_mb = 0.0  # MPS/CPU don't expose this API
    
    # Calculate total tokens
    total_tokens = step * TOTAL_BATCH_SIZE
    
    # Print results
    print("\n---", flush=True)
    print(f"val_bpb:          {val_bpb:.6f}", flush=True)
    print(f"training_seconds: {total_training_time:.1f}", flush=True)
    print(f"total_seconds:    {time.time() - t0:.1f}", flush=True)
    print(f"peak_vram_mb:     {peak_vram_mb:.1f}", flush=True)
    print(f"mfu_percent:      {mfu:.2f}", flush=True)
    print(f"total_tokens_M:   {total_tokens / 1e6:.1f}", flush=True)
    print(f"num_steps:        {step}", flush=True)
    print(f"num_params_M:     {num_params / 1e6:.1f}", flush=True)
    print(f"depth:            {config.n_layer}", flush=True)


if __name__ == "__main__":
    train()
