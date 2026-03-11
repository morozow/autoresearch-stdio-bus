#!/usr/bin/env python3
"""
QEI Demo — демонстрация квантового эпистемического импульса.

Запуск:
    python -m qei.demo

Что происходит:
1. Система слушает квантовый вакуум (ANU QRNG)
2. Когда импульс ВОЗНИКАЕТ — формируется вопрос
3. Вопрос не вычислен из предыдущего состояния — он возник из измерения

Это прототип. Цель — понять на практике, что значит
"причина генерации из квантовой неопределённости".
"""
import asyncio
from datetime import datetime

from .impulse import ImpulseSource, Impulse
from .inquiry import inquiry_from_impulse


async def on_impulse_arose(impulse: Impulse):
    """
    Обработчик возникшего импульса.
    
    Когда импульс возник — разворачиваем его в вопрос.
    """
    print(f"\n{'='*60}")
    print(f"ИМПУЛЬС ВОЗНИК: {impulse.timestamp.isoformat()}")
    print(f"Квантовое значение: {impulse.quantum_value} (0x{impulse.quantum_value:04x})")
    
    # Развернуть импульс в вопрос
    inquiry = await inquiry_from_impulse(impulse)
    
    print(f"\nВОЗНИКШИЙ ВОПРОС:")
    print(f"  Направление: {inquiry.direction}")
    print(f"  Контекст: 0x{inquiry.context_seed:04x}")
    print(f"  Полный: {inquiry.question}")
    print(f"{'='*60}\n")


async def main():
    print("""
╔══════════════════════════════════════════════════════════════╗
║     QEI — Quantum Epistemic Impulse Prototype                ║
║                                                              ║
║     Слушаем квантовый вакуум...                              ║
║     Когда импульс ВОЗНИКНЕТ — появится вопрос.               ║
║                                                              ║
║     Это не триггер. Это не генератор.                        ║
║     Это источник того, что ПОРОЖДАЕТ вопросы.                ║
╚══════════════════════════════════════════════════════════════╝
    """)
    
    source = ImpulseSource()
    source.on_impulse(on_impulse_arose)
    
    try:
        # Слушаем с интервалом 2 секунды
        # (чтобы не перегружать ANU API)
        await source.listen(interval_seconds=2.0)
    except KeyboardInterrupt:
        source.stop()
        print(f"\n\nСтатистика:")
        print(f"  Всего измерений: {source.stats['total_measurements']}")
        print(f"  Импульсов возникло: {source.stats['impulses_arose']}")
        print(f"  Соотношение: {source.stats['ratio']:.2%}")


if __name__ == "__main__":
    asyncio.run(main())
