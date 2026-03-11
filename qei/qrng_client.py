"""
QRNG Client — получение квантовых случайных чисел от ANU

Quantum random numbers from vacuum fluctuations.
The source of birth, will, and spontaneous thought.

Optimized: requests only what's needed, caches excess.
Falls back to os.urandom when quantum source unavailable.
"""
import os
import asyncio
import aiohttp
import ssl
import certifi
from typing import Optional, Union
from collections import deque

ANU_URL = "https://api.quantumnumbers.anu.edu.au"
DEFAULT_API_KEY = "44QlDEOGfj6hlmvo4rMY92AXBH2OFoIl6UxwWvoZ"

# Cache for excess quantum bytes
_quantum_cache: deque = deque(maxlen=1024)
_cache_lock = asyncio.Lock()

# Track quantum vs fallback usage
_quantum_calls = 0
_fallback_calls = 0
_cache_hits = 0


async def _fetch_from_anu(length: int, data_type: str = "uint8") -> Optional[list]:
    """Raw fetch from ANU API."""
    global _quantum_calls
    
    # Clamp to API limits
    length = min(length, 1024)
    
    url = f"{ANU_URL}?type={data_type}&length={length}"
    
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    connector = aiohttp.TCPConnector(ssl=ssl_context)
    
    try:
        async with aiohttp.ClientSession(connector=connector) as session:
            headers = {"x-api-key": DEFAULT_API_KEY}
            async with session.get(url, headers=headers, timeout=aiohttp.ClientTimeout(total=5)) as resp:
                if resp.status != 200:
                    return None
                data = await resp.json()
                _quantum_calls += 1
                return data.get("data", [])
    except Exception:
        return None


async def fetch_quantum_bits(length: int = 1) -> Union[list[int], bytes]:
    """
    Получить квантовые случайные байты.
    
    length=1: returns list[int] with one uint8 value
    length>1: returns bytes
    
    Uses cache first, fetches only what's needed.
    Falls back to os.urandom if quantum source unavailable.
    """
    global _fallback_calls, _cache_hits
    
    needed = length if length > 1 else 1
    result = []
    
    async with _cache_lock:
        # Take from cache first
        while _quantum_cache and len(result) < needed:
            result.append(_quantum_cache.popleft())
            _cache_hits += 1
        
        # Need more?
        remaining = needed - len(result)
        if remaining > 0:
            # Fetch with small buffer (request 2x what we need, up to 64)
            fetch_count = min(max(remaining * 2, 8), 64)
            fresh = await _fetch_from_anu(fetch_count, "uint8")
            
            if fresh:
                # Take what we need
                result.extend(fresh[:remaining])
                # Cache the rest
                for v in fresh[remaining:]:
                    _quantum_cache.append(v)
            else:
                # Fallback to os.urandom
                _fallback_calls += 1
                fallback = list(os.urandom(remaining))
                result.extend(fallback)
    
    # Return format
    if length == 1:
        return result[:1]
    else:
        return bytes(result[:length])


async def fetch_impulse_bit() -> bool:
    """
    Получить один квантовый бит — импульс.
    
    True = импульс возник
    False = тишина
    """
    values = await fetch_quantum_bits(1)
    if not values:
        return False
    return (values[0] & 1) == 1


def get_source_stats() -> dict:
    """Return quantum vs fallback usage stats."""
    total = _quantum_calls + _fallback_calls
    return {
        "quantum_calls": _quantum_calls,
        "fallback_calls": _fallback_calls,
        "cache_hits": _cache_hits,
        "cache_size": len(_quantum_cache),
        "quantum_ratio": _quantum_calls / total if total > 0 else 0,
    }
