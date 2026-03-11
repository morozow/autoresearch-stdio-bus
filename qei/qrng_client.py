"""
QRNG Client — получение квантовых случайных чисел от ANU

Quantum random numbers from vacuum fluctuations.
The source of birth, will, and spontaneous thought.
"""
import aiohttp
import ssl
import certifi
from typing import Optional, Union

ANU_URL = "https://api.quantumnumbers.anu.edu.au"
DEFAULT_API_KEY = "44QlDEOGfj6hlmvo4rMY92AXBH2OFoIl6UxwWvoZ"


async def fetch_quantum_bits(
    length: int = 1,
    api_key: Optional[str] = None
) -> Union[list[int], bytes]:
    """
    Получить квантовые случайные числа от ANU QRNG.
    
    Возвращает список uint16 значений (0-65535).
    Каждое значение — результат измерения вакуумных флуктуаций.
    
    This is not random. This is QUANTUM.
    These numbers arise from the fabric of reality itself.
    """
    key = api_key or DEFAULT_API_KEY
    url = f"{ANU_URL}?type=uint16&length={length}&size=1"
    
    # SSL context for secure connection
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    connector = aiohttp.TCPConnector(ssl=ssl_context)
    
    async with aiohttp.ClientSession(connector=connector) as session:
        headers = {"x-api-key": key}
        async with session.get(url, headers=headers) as resp:
            if resp.status != 200:
                raise RuntimeError(f"QRNG API error: {resp.status}")
            data = await resp.json()
            values = data.get("data", [])
            
            # If length > 1, convert to bytes for seed
            if length > 1:
                result = b''
                for v in values:
                    result += v.to_bytes(2, 'big')
                return result
            
            return values


async def fetch_impulse_bit() -> bool:
    """
    Получить один квантовый бит — импульс.
    
    True = импульс возник (потребность в вопросе)
    False = импульс не возник (тишина)
    """
    values = await fetch_quantum_bits(1)
    if not values:
        return False
    # Берём младший бит первого числа
    return (values[0] & 1) == 1
