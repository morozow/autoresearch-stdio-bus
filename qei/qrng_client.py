"""
QRNG Client — получение квантовых случайных чисел от ANU
"""
import aiohttp
from typing import Optional

ANU_URL = "https://api.quantumnumbers.anu.edu.au"
DEFAULT_API_KEY = "44QlDEOGfj6hlmvo4rMY92AXBH2OFoIl6UxwWvoZ"


async def fetch_quantum_bits(
    length: int = 1,
    api_key: Optional[str] = None
) -> list[int]:
    """
    Получить квантовые случайные числа от ANU QRNG.
    
    Возвращает список uint16 значений (0-65535).
    Каждое значение — результат измерения вакуумных флуктуаций.
    """
    key = api_key or DEFAULT_API_KEY
    url = f"{ANU_URL}?type=uint16&length={length}&size=1"
    
    async with aiohttp.ClientSession() as session:
        headers = {"x-api-key": key}
        async with session.get(url, headers=headers) as resp:
            if resp.status != 200:
                raise RuntimeError(f"QRNG API error: {resp.status}")
            data = await resp.json()
            return data.get("data", [])


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
