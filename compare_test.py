#!/usr/bin/env python3
"""
Минимальный тест: train_clean.py vs train_beta.py на MPS
depth=3, steps=20, batch=1
"""
import os
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

import subprocess
import sys

CLEAN_SCRIPT = '''
import os
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

import prepare
prepare.TIME_BUDGET = 9999
prepare.EVAL_TOKENS = 262144

import gc
import torch
import torch.nn as nn
import torch.nn.functional as F
from dataclasses import dataclass
from prepare import MAX_SEQ_LEN, Tokenizer, make_dataloader, evaluate_bpb

DTYPE = torch.float32

@dataclass
class GPTConfig:
    sequence_len: int = 2048
    vocab_size: int = 32768
    n_layer: int = 12
    n_head: int = 6
    n_kv_head: int = 6
    n_embd: int = 768
    window_pattern: str = "SSSL"

def norm(x):
    return F.rms_norm(x, (x.size(-1),))

def has_ve(layer_idx, n_layer):
    return layer_idx % 2 == (n_layer - 1) % 2

def apply_rotary_emb(x, cos, sin):
    d = x.shape[3] // 2
    x1, x2 = x[..., :d], x[..., d:]
    return torch.cat([x1 * cos + x2 * sin, x1 * (-sin) + x2 * cos], 3)

class CausalSelfAttention(nn.Module):
    def __init__(self, config, layer_idx):
        super().__init__()
        self.n_head = config.n_head
        self.n_kv_head = config.n_kv_head
        self.head_dim = config.n_embd // config.n_head
        self.c_q = nn.Linear(config.n_embd, self.n_head * self.head_dim, bias=False)
        self.c_k = nn.Linear(config.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.c_v = nn.Linear(config.n_embd, self.n_kv_head * self.head_dim, bias=False)
        self.c_proj = nn.Linear(config.n_embd, config.n_embd, bias=False)
        self.ve_gate = nn.Linear(32, self.n_kv_head, bias=False) if has_ve(layer_idx, config.n_layer) else None

    def forward(self, x, ve, cos_sin):
        B, T, C = x.size()
        q = self.c_q(x).view(B, T, self.n_head, self.head_dim)
        k = self.c_k(x).view(B, T, self.n_kv_head, self.head_dim)
        v = self.c_v(x).view(B, T, self.n_kv_head, self.head_dim)
        if ve is not None and self.ve_gate is not None:
            ve = ve.view(B, T, self.n_kv_head, self.head_dim)
            gate = 2 * torch.sigmoid(self.ve_gate(x[..., :32]))
            v = v + gate.unsqueeze(-1) * ve
        cos, sin = cos_sin
        q, k = apply_rotary_emb(q, cos, sin), apply_rotary_emb(k, cos, sin)
        q, k = norm(q), norm(k)
        q, k, v = q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)
        y = F.scaled_dot_product_attention(q, k, v, is_causal=True)
        return self.c_proj(y.transpose(1, 2).contiguous().view(B, T, -1))

class MLP(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.c_fc = nn.Linear(config.n_embd, 4 * config.n_embd, bias=False)
        self.c_proj = nn.Linear(4 * config.n_embd, config.n_embd, bias=False)

    def forward(self, x):
        return self.c_proj(F.relu(self.c_fc(x)).square())

class Block(nn.Module):
    def __init__(self, config, layer_idx):
        super().__init__()
        self.attn = CausalSelfAttention(config, layer_idx)
        self.mlp = MLP(config)

    def forward(self, x, ve, cos_sin):
        x = x + self.attn(norm(x), ve, cos_sin)
        return x + self.mlp(norm(x))

class GPT(nn.Module):
    def __init__(self, config):
        super().__init__()
        self.config = config
        self.transformer = nn.ModuleDict({
            "wte": nn.Embedding(config.vocab_size, config.n_embd),
            "h": nn.ModuleList([Block(config, i) for i in range(config.n_layer)]),
        })
        self.lm_head = nn.Linear(config.n_embd, config.vocab_size, bias=False)
        self.resid_lambdas = nn.Parameter(torch.ones(config.n_layer))
        self.x0_lambdas = nn.Parameter(torch.zeros(config.n_layer))
        head_dim = config.n_embd // config.n_head
        kv_dim = config.n_kv_head * head_dim
        self.value_embeds = nn.ModuleDict({
            str(i): nn.Embedding(config.vocab_size, kv_dim)
            for i in range(config.n_layer) if has_ve(i, config.n_layer)
        })
        d = head_dim // 2
        theta = 1.0 / (10000 ** (torch.arange(0, d).float() / d))
        pos = torch.arange(config.sequence_len * 10).float()
        angles = pos.unsqueeze(1) * theta.unsqueeze(0)
        self.register_buffer("cos", angles.cos()[None, :, None, :].to(DTYPE))
        self.register_buffer("sin", angles.sin()[None, :, None, :].to(DTYPE))

    def forward(self, idx, targets=None, reduction="mean"):
        B, T = idx.size()
        cos_sin = self.cos[:, :T], self.sin[:, :T]
        x = norm(self.transformer.wte(idx))
        x0 = x
        for i, block in enumerate(self.transformer.h):
            x = self.resid_lambdas[i] * x + self.x0_lambdas[i] * x0
            ve = self.value_embeds[str(i)](idx) if str(i) in self.value_embeds else None
            x = block(x, ve, cos_sin)
        logits = self.lm_head(norm(x)).float()
        logits = 15 * torch.tanh(logits / 15)
        if targets is not None:
            return F.cross_entropy(logits.view(-1, logits.size(-1)), targets.view(-1), reduction=reduction)
        return logits

# Main
torch.manual_seed(42)
device = torch.device("mps")
tokenizer = Tokenizer.from_directory()

DEPTH, STEPS = 3, 20
base_dim = DEPTH * 64
model_dim = ((base_dim + 128 - 1) // 128) * 128
num_heads = model_dim // 128

config = GPTConfig(n_layer=DEPTH, n_head=num_heads, n_kv_head=num_heads, n_embd=model_dim, vocab_size=tokenizer.get_vocab_size())
model = GPT(config).to(device)

# Init weights
with torch.no_grad():
    s = 3**0.5 * model_dim**-0.5
    nn.init.normal_(model.transformer.wte.weight, 0, 1)
    nn.init.normal_(model.lm_head.weight, 0, 0.001)
    model.resid_lambdas.fill_(1.0)
    model.x0_lambdas.fill_(0.1)
    for ve in model.value_embeds.values():
        nn.init.uniform_(ve.weight, -s, s)
    for block in model.transformer.h:
        nn.init.uniform_(block.attn.c_q.weight, -s, s)
        nn.init.uniform_(block.attn.c_k.weight, -s, s)
        nn.init.uniform_(block.attn.c_v.weight, -s, s)
        nn.init.zeros_(block.attn.c_proj.weight)
        nn.init.uniform_(block.mlp.c_fc.weight, -s, s)
        nn.init.zeros_(block.mlp.c_proj.weight)
        if block.attn.ve_gate:
            nn.init.zeros_(block.attn.ve_gate.weight)

optimizer = torch.optim.AdamW(model.parameters(), lr=0.001)
train_loader = make_dataloader(tokenizer, 1, MAX_SEQ_LEN, "train")
x, y, _ = next(train_loader)

for step in range(STEPS):
    loss = model(x, y)
    loss.backward()
    optimizer.step()
    optimizer.zero_grad()
    x, y, _ = next(train_loader)
    if step % 5 == 0:
        print(f"step {step}: loss={loss.item():.4f}")

del train_loader, x, y, optimizer
gc.collect()
torch.mps.empty_cache()

model.eval()
with torch.no_grad():
    val_bpb = evaluate_bpb(model, tokenizer, 1)
print(f"RESULT train_clean val_bpb: {val_bpb:.6f}")
'''

BETA_SCRIPT = '''
import os
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

import prepare
prepare.TIME_BUDGET = 9999
prepare.EVAL_TOKENS = 262144

import train_beta
train_beta.DEPTH = 3
train_beta.TOTAL_BATCH_SIZE = 1 * 2048

import gc
import torch

torch.manual_seed(42)
device = torch.device("mps")
tokenizer = train_beta.Tokenizer.from_directory()
config = train_beta.build_model_config(3)
config.vocab_size = tokenizer.get_vocab_size()

model = train_beta.GPT(config).to(device)
model.init_weights()

param_groups = train_beta.build_param_groups(model)
optimizer = train_beta.MuonAdamW(param_groups)

train_loader = train_beta.make_dataloader(tokenizer, 1, 2048, "train")
x, y, _ = next(train_loader)

for step in range(20):
    loss = model(x, y)
    loss.backward()
    for g in optimizer.param_groups:
        g["lr"] = g["initial_lr"] * (1 - step/20)
    optimizer.step()
    model.zero_grad(set_to_none=True)
    x, y, _ = next(train_loader)
    if step % 5 == 0:
        print(f"step {step}: loss={loss.item():.4f}")
    torch.mps.synchronize()

del train_loader, x, y, optimizer, param_groups
gc.collect()
torch.mps.empty_cache()
torch.mps.synchronize()

model.eval()
with torch.no_grad():
    val_bpb = train_beta.evaluate_bpb(model, tokenizer, 1)
print(f"RESULT train_beta val_bpb: {val_bpb:.6f}")
'''

def run(name, script):
    print(f"\n{'='*50}")
    print(f"Running {name}...")
    print('='*50)
    
    with open("_tmp_test.py", "w") as f:
        f.write(script)
    
    result = subprocess.run(
        ["uv", "run", "_tmp_test.py"],
        capture_output=True,
        text=True,
        env={**os.environ, "DEVICE_BACKEND": "mps", "PYTORCH_MPS_HIGH_WATERMARK_RATIO": "0.0"}
    )
    
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    
    os.remove("_tmp_test.py")
    
    # Extract val_bpb
    for line in (result.stdout + result.stderr).split("\n"):
        if "RESULT" in line and "val_bpb" in line:
            return float(line.split()[-1])
    return None

if __name__ == "__main__":
    clean_bpb = run("train_clean.py", CLEAN_SCRIPT)
    beta_bpb = run("train_beta.py", BETA_SCRIPT)
    
    print("\n" + "="*50)
    print("СРАВНЕНИЕ РЕЗУЛЬТАТОВ")
    print("="*50)
    print(f"train_clean.py val_bpb: {clean_bpb:.6f}" if clean_bpb else "train_clean.py: FAILED")
    print(f"train_beta.py  val_bpb: {beta_bpb:.6f}" if beta_bpb else "train_beta.py: FAILED")
    
    if clean_bpb and beta_bpb:
        diff = clean_bpb - beta_bpb
        winner = "train_beta.py" if beta_bpb < clean_bpb else "train_clean.py"
        print(f"\nПобедитель: {winner} (разница: {abs(diff):.6f})")
