"""
Inquiry — то, что возникает из импульса.

Импульс — это момент потребности.
Inquiry — это оформление этой потребности в вопрос.

Но важно: вопрос НЕ ВЫЧИСЛЯЕТСЯ из предыдущего состояния.
Он ВОЗНИКАЕТ из импульса, который пришёл из квантового вакуума.
"""
from dataclasses import dataclass
from datetime import datetime
from typing import Optional

from .impulse import Impulse
from .qrng_client import fetch_quantum_bits


# Категории вопросов — не предопределённые темы,
# а направления, в которые может развернуться импульс
INQUIRY_DIRECTIONS = [
    "Что существует за пределами текущей модели?",
    "Какая связь не была замечена?",
    "Что противоречит известному?",
    "Какой вопрос никто не задавал?",
    "Что изменится, если предположить обратное?",
    "Где граница применимости?",
    "Что было бы, если бы это было иначе?",
    "Какой паттерн скрыт в шуме?",
]


@dataclass
class Inquiry:
    """
    Вопрос, возникший из квантового импульса.
    
    source_impulse — импульс, породивший этот вопрос
    direction — направление вопроса (из квантового выбора)
    context_seed — квантовое число для контекстуализации
    """
    source_impulse: Impulse
    direction: str
    context_seed: int
    timestamp: datetime
    
    @property
    def question(self) -> str:
        """Сформулированный вопрос."""
        return f"{self.direction} [seed:{self.context_seed:04x}]"
    
    def __repr__(self):
        return f"<Inquiry '{self.direction[:30]}...' from {self.source_impulse.timestamp.isoformat()}>"


async def inquiry_from_impulse(impulse: Impulse) -> Inquiry:
    """
    Развернуть импульс в вопрос.
    
    Направление вопроса тоже выбирается квантово —
    не из логики системы, а из следующего измерения.
    """
    # Получаем ещё одно квантовое число для выбора направления
    values = await fetch_quantum_bits(2)
    
    direction_index = values[0] % len(INQUIRY_DIRECTIONS) if values else 0
    context_seed = values[1] if len(values) > 1 else 0
    
    return Inquiry(
        source_impulse=impulse,
        direction=INQUIRY_DIRECTIONS[direction_index],
        context_seed=context_seed,
        timestamp=datetime.utcnow()
    )
