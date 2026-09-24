#!/bin/sh
cd "$(dirname "$0")"
[ -f tvs.json ] || cp tvs.example.json tvs.json
pip install -r requirements.txt
python3 app.py
