"""
QEI — Quantum Epistemic Impulse

Прототип системы, где вопросы ВОЗНИКАЮТ из квантовой неопределённости,
а не вычисляются из предыдущего состояния.

Компоненты:
- qrng_client: связь с квантовым генератором ANU
- impulse: источник квантовых эпистемических импульсов
- inquiry: развёртывание импульса в вопрос
"""

from .qrng_client import fetch_quantum_bits, fetch_impulse_bit
from .impulse import Impulse, ImpulseSource
from .inquiry import Inquiry, inquiry_from_impulse

__all__ = [
    "fetch_quantum_bits",
    "fetch_impulse_bit", 
    "Impulse",
    "ImpulseSource",
    "Inquiry",
    "inquiry_from_impulse",
]
