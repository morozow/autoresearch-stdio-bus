"""
Quantum Epistemic Impulse (QEI)

Это не триггер. Это не механизм выбора.
Это момент, когда из квантовой неопределённости ВОЗНИКАЕТ 
потребность в вопросе — до того, как есть сам вопрос.

В детерминированной системе вопрос вычисляется из предыдущего состояния.
Здесь вопрос ВОЗНИКАЕТ из ткани реальности.
"""
import asyncio
from datetime import datetime
from dataclasses import dataclass
from typing import Optional, Callable, Awaitable

from .qrng_client import fetch_impulse_bit, fetch_quantum_bits


@dataclass
class Impulse:
    """
    Квантовый эпистемический импульс.
    
    Это не данные. Это событие возникновения.
    timestamp — когда измерение произошло
    quantum_value — сырое значение из вакуума
    arose — возник ли импульс (потребность в вопросе)
    """
    timestamp: datetime
    quantum_value: int
    arose: bool
    
    def __repr__(self):
        status = "AROSE" if self.arose else "silent"
        return f"<Impulse {self.timestamp.isoformat()} [{status}] q={self.quantum_value}>"


class ImpulseSource:
    """
    Источник квантовых эпистемических импульсов.
    
    Не генератор вопросов. Не триггер.
    Источник моментов, когда потребность в вопросе ВОЗНИКАЕТ.
    """
    
    def __init__(self):
        self._listeners: list[Callable[[Impulse], Awaitable[None]]] = []
        self._running = False
        self._impulse_count = 0
        self._arose_count = 0
    
    def on_impulse(self, callback: Callable[[Impulse], Awaitable[None]]):
        """Подписаться на импульсы."""
        self._listeners.append(callback)
    
    async def _emit(self, impulse: Impulse):
        """Передать импульс всем слушателям."""
        for listener in self._listeners:
            await listener(impulse)
    
    async def measure_once(self) -> Impulse:
        """
        Произвести одно измерение.
        
        Это акт взаимодействия с квантовым вакуумом.
        Результат не предопределён ничем в нашей системе.
        """
        values = await fetch_quantum_bits(1)
        quantum_value = values[0] if values else 0
        arose = (quantum_value & 1) == 1
        
        impulse = Impulse(
            timestamp=datetime.utcnow(),
            quantum_value=quantum_value,
            arose=arose
        )
        
        self._impulse_count += 1
        if arose:
            self._arose_count += 1
        
        return impulse
    
    async def listen(self, interval_seconds: float = 1.0):
        """
        Слушать квантовый вакуум.
        
        Каждые interval_seconds производим измерение.
        Когда импульс возникает — оповещаем слушателей.
        """
        self._running = True
        print(f"[ImpulseSource] Начинаю слушать квантовый вакуум...")
        
        while self._running:
            impulse = await self.measure_once()
            
            if impulse.arose:
                print(f"[ImpulseSource] {impulse}")
                await self._emit(impulse)
            
            await asyncio.sleep(interval_seconds)
    
    def stop(self):
        """Прекратить слушать."""
        self._running = False
    
    @property
    def stats(self) -> dict:
        return {
            "total_measurements": self._impulse_count,
            "impulses_arose": self._arose_count,
            "ratio": self._arose_count / self._impulse_count if self._impulse_count > 0 else 0
        }
