# -*- coding: utf-8 -*-
"""Generate PNG charts for the benchmark README and the economic note (matplotlib)."""
import os, sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import FuncFormatter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "assets")
os.makedirs(OUT, exist_ok=True)

NAVY   = "#1F3864"
RED    = "#C0392B"
GREEN  = "#2E7D32"
GREY   = "#7F7F7F"

plt.rcParams.update({
    "font.size": 11,
    "axes.titlesize": 13,
    "axes.titleweight": "bold",
    "axes.edgecolor": GREY,
    "axes.linewidth": 0.8,
    "figure.dpi": 150,
})

def _clean(ax):
    ax.spines["top"].set_visible(False)
    ax.spines["right"].set_visible(False)
    ax.yaxis.grid(True, color="#E0E0E0", linewidth=0.8)
    ax.set_axisbelow(True)

def save(fig, name):
    p = os.path.join(OUT, name)
    fig.tight_layout()
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    print("wrote", p)

# ---------- 1. token savings multiplier ----------
def chart_token_savings():
    labels = ["medium\ntypical", "large\ntypical", "medium\nworst-case", "large\nworst-case"]
    vals   = [18, 12, 115, 120]
    colors = [GREEN, GREEN, NAVY, NAVY]
    fig, ax = plt.subplots(figsize=(7.2, 4.0))
    bars = ax.bar(labels, vals, color=colors, width=0.62)
    for b, v in zip(bars, vals):
        ax.text(b.get_x()+b.get_width()/2, v+2, f"{v}×", ha="center", va="bottom",
                fontweight="bold", fontsize=12)
    ax.set_ylabel("times fewer tokens  (higher = better)")
    ax.set_title("Token savings with the PROJECT_MAP index")
    ax.set_ylim(0, 135)
    _clean(ax)
    fig.text(0.5, -0.02, "Realistic blast-radius query  ·  baseline = recursive Grep navigation",
             ha="center", fontsize=9, color=GREY)
    save(fig, "fig_token_savings.png")

# ---------- 2. absolute tokens, log scale ----------
def chart_tokens_absolute():
    groups = ["medium (51 files)", "large (151 files)"]
    no_map = [79227, 242126]
    w_map  = [692, 2009]
    x = range(len(groups)); width = 0.36
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    b1 = ax.bar([i-width/2 for i in x], no_map, width, label="Without index (Grep)", color=RED)
    b2 = ax.bar([i+width/2 for i in x], w_map,  width, label="With index (1 read)",  color=GREEN)
    ax.set_yscale("log")
    ax.set_xticks(list(x)); ax.set_xticklabels(groups)
    ax.set_ylabel("tokens per blast-radius query  (log scale)")
    ax.set_title("Tokens to map a change's blast radius (worst case)")
    for bars in (b1, b2):
        for b in bars:
            ax.text(b.get_x()+b.get_width()/2, b.get_height()*1.08,
                    f"{int(b.get_height()):,}", ha="center", va="bottom", fontsize=9, fontweight="bold")
    ax.legend(frameon=False, loc="upper left")
    ax.set_ylim(100, 600000)
    _clean(ax)
    save(fig, "fig_tokens_absolute.png")

# ---------- 3. round-trips ----------
def chart_roundtrips():
    labels = ["medium\ntypical", "large\ntypical", "medium\nworst", "large\nworst"]
    nomap  = [9, 16, 51, 151]
    fig, ax = plt.subplots(figsize=(7.2, 4.0))
    bars = ax.bar(labels, nomap, color=RED, width=0.6, label="Without index (calls)")
    ax.axhline(1, color=GREEN, linewidth=2.2, label="With index = 1 call")
    for b, v in zip(bars, nomap):
        ax.text(b.get_x()+b.get_width()/2, v+2, str(v), ha="center", va="bottom", fontweight="bold")
    ax.set_ylabel("tool calls / round-trips  (lower = better)")
    ax.set_title("Round-trips: one Grep per affected file vs. a single read")
    ax.set_ylim(0, 168)
    ax.legend(frameon=False, loc="upper left")
    _clean(ax)
    save(fig, "fig_roundtrips.png")

# ---------- economics ----------
MXN_PER_USD = 18.0
EXP_MXN  = 1750.0                  # MXN / month (high tier)
CHEAP_USD = 20.0
CHEAP_MXN = CHEAP_USD * MXN_PER_USD     # ~360 MXN
EXP_USD  = EXP_MXN / MXN_PER_USD        # ~97.22 USD
SAVE_MXN = EXP_MXN - CHEAP_MXN          # 1390
SAVE_USD = EXP_USD - CHEAP_USD          # 77.22
PCT = SAVE_MXN / EXP_MXN * 100          # 79.4
USERS = [1, 5, 10, 25, 50]

# ===== USD / English (for the GitHub README) =====
def chart_cost_monthly_usd():
    labels = [f"Without the tool\n(high tier)\n~${EXP_USD:,.0f}/mo",
              f"With the tool\n(Pro plan)\n${CHEAP_USD:,.0f}/mo"]
    vals = [EXP_USD, CHEAP_USD]
    fig, ax = plt.subplots(figsize=(7.0, 4.2))
    bars = ax.bar(labels, vals, color=[RED, GREEN], width=0.55)
    for b, v in zip(bars, vals):
        ax.text(b.get_x()+b.get_width()/2, v+1.5, f"${v:,.0f}", ha="center", va="bottom", fontweight="bold")
    ax.annotate(f"-{PCT:.0f}%  (-${SAVE_USD:,.0f}/mo per user)",
                xy=(1, CHEAP_USD), xytext=(0.5, EXP_USD*0.62),
                ha="center", fontsize=12, fontweight="bold", color=GREEN,
                arrowprops=dict(arrowstyle="->", color=GREEN, lw=1.6))
    ax.set_ylabel("Monthly cost per user (USD)")
    ax.set_title("Monthly cost saving per user")
    ax.set_ylim(0, EXP_USD*1.18)
    _clean(ax)
    save(fig, "fig_cost_monthly_usd.png")

def chart_cost_scaling_usd():
    annual = [u * SAVE_USD * 12 for u in USERS]
    fig, ax = plt.subplots(figsize=(7.2, 4.2))
    bars = ax.bar([str(u) for u in USERS], annual, color=NAVY, width=0.6)
    for b, v in zip(bars, annual):
        ax.text(b.get_x()+b.get_width()/2, v+annual[-1]*0.015,
                f"${v:,.0f}", ha="center", va="bottom", fontsize=9, fontweight="bold")
    ax.set_xlabel("Number of users / seats")
    ax.set_ylabel("Cumulative annual saving (USD)")
    ax.set_title("The benefit multiplies per user (annual saving)")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"${x:,.0f}"))
    _clean(ax)
    save(fig, "fig_cost_scaling_usd.png")

# ===== Bilingual MXN + USD / Spanish (for the docx note) =====
def chart_cost_monthly_bi():
    labels = [f"Sin la herramienta (plan alto)\n$1,750 MXN  (~$97 USD)/mes",
              f"Con la herramienta (plan Pro)\n$360 MXN  ($20 USD)/mes"]
    vals = [EXP_MXN, CHEAP_MXN]
    fig, ax = plt.subplots(figsize=(7.2, 4.3))
    bars = ax.bar(labels, vals, color=[RED, GREEN], width=0.55)
    for b, v in zip(bars, vals):
        ax.text(b.get_x()+b.get_width()/2, v+25, f"${v:,.0f} MXN", ha="center", va="bottom", fontweight="bold")
    ax.annotate(f"-{PCT:.0f}%  (-$1,390 MXN / -$77 USD por usuario/mes)",
                xy=(1, CHEAP_MXN), xytext=(0.5, EXP_MXN*0.62),
                ha="center", fontsize=11.5, fontweight="bold", color=GREEN,
                arrowprops=dict(arrowstyle="->", color=GREEN, lw=1.6))
    ax.set_ylabel("Costo mensual por usuario (MXN)")
    ax.set_title("Ahorro económico por usuario / mes")
    ax.set_ylim(0, 2050)
    _clean(ax)
    fig.text(0.5, -0.03, f"Conversión usada: 1 USD ≈ {MXN_PER_USD:.0f} MXN", ha="center", fontsize=8, color=GREY)
    save(fig, "fig_cost_monthly_bi.png")

def chart_cost_scaling_bi():
    annual_mxn = [u * SAVE_MXN * 12 for u in USERS]
    annual_usd = [u * SAVE_USD * 12 for u in USERS]
    fig, ax = plt.subplots(figsize=(7.4, 4.4))
    bars = ax.bar([str(u) for u in USERS], annual_mxn, color=NAVY, width=0.6)
    for b, m, u in zip(bars, annual_mxn, annual_usd):
        ax.text(b.get_x()+b.get_width()/2, m+annual_mxn[-1]*0.015,
                f"${m:,.0f} MXN\n(${u:,.0f} USD)", ha="center", va="bottom", fontsize=8, fontweight="bold")
    ax.set_xlabel("Número de usuarios / licencias")
    ax.set_ylabel("Ahorro anual acumulado (MXN)")
    ax.set_title("El beneficio se multiplica por usuario (ahorro anual)")
    ax.yaxis.set_major_formatter(FuncFormatter(lambda x, _: f"${x:,.0f}"))
    ax.set_ylim(0, annual_mxn[-1]*1.16)
    _clean(ax)
    save(fig, "fig_cost_scaling_bi.png")

if __name__ == "__main__":
    chart_token_savings()
    chart_tokens_absolute()
    chart_roundtrips()
    chart_cost_monthly_usd()
    chart_cost_scaling_usd()
    chart_cost_monthly_bi()
    chart_cost_scaling_bi()
    print("\nUSD: high=%.2f pro=%.0f save/mo=%.2f (%.0f%%) save/yr/user=%.0f"
          % (EXP_USD, CHEAP_USD, SAVE_USD, PCT, SAVE_USD*12))
    print("MXN: high=%.0f pro=%.0f save/mo=%.0f save/yr/user=%.0f"
          % (EXP_MXN, CHEAP_MXN, SAVE_MXN, SAVE_MXN*12))
