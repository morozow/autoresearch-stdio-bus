#!/usr/bin/env python3
"""
Реальное сравнение train_clean.py vs train_beta.py на MPS.
Запускает НАСТОЯЩИЕ файлы как subprocess.
"""
import os
import subprocess
import sys
import re

# Патчим prepare.py через env-переменные нельзя, поэтому создаём wrapper-скрипты

WRAPPER_CLEAN = '''
import os
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

# Патчим prepare ДО импорта train_clean
import prepare
prepare.TIME_BUDGET = 30  # 30 секунд вместо 5 минут
prepare.EVAL_TOKENS = 262144  # быстрый eval

# train_clean.py запускается при импорте (нет if __name__ guard)
# Поэтому просто exec его содержимое
exec(open("train_clean.py").read())
'''

WRAPPER_BETA = '''
import os
os.environ["DEVICE_BACKEND"] = "mps"
os.environ["PYTORCH_MPS_HIGH_WATERMARK_RATIO"] = "0.0"

# Патчим prepare ДО импорта
import prepare
prepare.TIME_BUDGET = 30  # 30 секунд
prepare.EVAL_TOKENS = 262144

# train_beta.py имеет if __name__ guard, вызываем train()
import train_beta
train_beta.train()
'''

def run_real(name, wrapper_code):
    print(f"\n{'='*60}")
    print(f"Запуск РЕАЛЬНОГО {name}")
    print('='*60 + "\n")
    
    # Важно: файл должен иметь .py расширение для uv run
    wrapper_file = f"_wrapper_{name.replace('.py', '')}.py"
    with open(wrapper_file, "w") as f:
        f.write(wrapper_code)
    
    try:
        result = subprocess.run(
            ["uv", "run", wrapper_file],
            capture_output=True,
            text=True,
            timeout=180,  # 3 минуты макс
        )
        
        output = result.stdout + result.stderr
        print(output)
        
        # Ищем val_bpb в выводе
        match = re.search(r'val_bpb:\s+([\d.]+)', output)
        if match:
            return float(match.group(1))
        return None
        
    except subprocess.TimeoutExpired:
        print("TIMEOUT!")
        return None
    finally:
        if os.path.exists(wrapper_file):
            os.remove(wrapper_file)

if __name__ == "__main__":
    print("="*60)
    print("РЕАЛЬНОЕ СРАВНЕНИЕ: train_clean.py vs train_beta.py")
    print("Конфиг: TIME_BUDGET=30s, EVAL_TOKENS=262144, MPS")
    print("="*60)
    
    clean_bpb = run_real("train_clean.py", WRAPPER_CLEAN)
    beta_bpb = run_real("train_beta.py", WRAPPER_BETA)
    
    print("\n" + "="*60)
    print("ИТОГОВОЕ СРАВНЕНИЕ")
    print("="*60)
    
    if clean_bpb:
        print(f"train_clean.py val_bpb: {clean_bpb:.6f}")
    else:
        print("train_clean.py: FAILED")
        
    if beta_bpb:
        print(f"train_beta.py  val_bpb: {beta_bpb:.6f}")
    else:
        print("train_beta.py: FAILED")
    
    if clean_bpb and beta_bpb:
        diff = clean_bpb - beta_bpb
        if beta_bpb < clean_bpb:
            print(f"\nПобедитель: train_beta.py (лучше на {abs(diff):.6f})")
        else:
            print(f"\nПобедитель: train_clean.py (лучше на {abs(diff):.6f})")
