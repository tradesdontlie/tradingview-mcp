# RSI + Bollinger Bands + Volume Profile — Análise Diária
**Ativos:** SMAL11 | BBAS3 | VALE3  
**Data-base:** 29/mai/2026 | **Timeframe:** 1D | **Parâmetros:** BB(20,2) · RSI(14 — Wilder)

---

## RESUMO EXECUTIVO

| Ativo | Fechamento | BB Inferior | BB Médio | BB Superior | RSI 14 | Cenário |
|---|---|---|---|---|---|---|
| SMAL11 | R$ 110,99 | R$ 107,96 | R$ 113,42 | R$ 118,88 | **38,6** | 🟡 Neutro — sem sinal |
| BBAS3 | R$ 20,30 | **R$ 19,98** | R$ 21,12 | R$ 22,25 | **31,4** | 🔴 Pré-Cenário B |
| VALE3 | R$ 82,82 | R$ 79,00 | R$ 82,23 | R$ 85,47 | **49,2** | 🔵 Pré-Cenário C + VP |

---

## 1. SMAL11 — Neutro, recuperação pós-oversold

### Indicadores
| Métrica | Valor |
|---|---|
| Fechamento | R$ 110,99 |
| SMA 20 | R$ 113,42 |
| BB Superior | R$ 118,88 |
| BB Inferior | R$ 107,96 |
| Largura BB | 9,6% |
| RSI 14 | 38,6 |

### Diagnóstico
O SMAL11 está **abaixo da média de 20 dias (113,42)** e no terço inferior da banda, mas **acima da banda inferior (107,96)**. RSI em 38,6 indica fraqueza sem atingir o limiar de sobrevendido (30).

O ativo chegou próximo a acionar o Cenário B quando atingiu a mínima de R$ 108,83 (≈11 pregões atrás), com RSI estimado em ~33-34 naquele ponto — porém **sem cruzar os 30**. O bounce subsequente para 114,60 dissipou o sinal.

**Nenhum cenário clássico A, B ou C ativo no momento.**

### Condições para acionamento
| Cenário | Condição necessária | Estratégia |
|---|---|---|
| Cenário B (baixa → reversão) | Fechar ≤ 107,96 **e** RSI < 30 | Bull Put Spread |
| Consolidação neutra | Permanecer entre 108 e 115 | Strangle Vendido |
| Alta | Fechar acima de 113,42 + RSI > 50 | Bull Call Spread |

> ⏳ **Ação:** Monitorar. Sem entrada no momento.

---

## 2. BBAS3 — ⚠️ PRÉ-CENÁRIO B: Gatilho iminente

### Indicadores
| Métrica | Valor |
|---|---|
| Fechamento | R$ 20,30 |
| SMA 20 | R$ 21,12 |
| BB Superior | R$ 22,25 |
| BB Inferior | **R$ 19,98** |
| Distância ao BB Inferior | **R$ 0,32 (1,6%)** |
| Largura BB | 10,7% |
| RSI 14 | **31,4** |
| Distância ao nível 30 | **1,4 pontos** |

### Diagnóstico
Este é o ativo **mais próximo de um sinal clássico** entre os três analisados. Ambos os termômetros do Cenário B estão praticamente no gatilho:

- **Preço** está a 1,6% da Banda Inferior (19,98)
- **RSI** está a 1,4 ponto de cruzar os 30

A queda de BBAS3 foi gradual e persistente (~17,9% em 35 pregões), sem uma pernada única de capitulação. Isso explica o RSI acima de 30 — o suavizamento de Wilder dilui as perdas incrementais. O sinal está amadurecendo.

### Estratégia: Trava de Alta com Puts (Bull Put Spread)

**Gatilho de entrada:** Fechamento abaixo de **R$ 19,98** (BB Inferior) **e** RSI < 30 (simultaneamente)

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | **Venda PUT** | R$ 20,00 |
| Perna 2 | **Compra PUT** | R$ 18,50 |

- **Ganho máximo:** prêmio líquido coletado (se BBAS3 ≥ R$ 20,00 no vencimento)
- **Perda máxima:** R$ 1,50 − prêmio recebido (spread de R$ 1,50)
- **Lógica:** A IV das Puts está inflada pelo pânico. Vender esse exagero com proteção capta o colapso de IV + decaimento temporal (Theta) quando o preço estabilizar ou repicar.
- **Stop:** Fechamento semanal abaixo de **R$ 18,50** (rompimento estrutural)
- **Alvo:** Retorno ao BB Médio (R$ 21,12)

> 🔔 **Alerta a configurar manualmente no TradingView:**
> BBAS3 · Cruzamento para baixo · R$ 19,98
> Mensagem: "GATILHO CENÁRIO B — confirmar RSI < 30 antes de entrar"

---

## 3. VALE3 — 🔵 PRÉ-CENÁRIO C + Volume Profile

### 3.1 Indicadores RSI + BB

| Métrica | Valor |
|---|---|
| Fechamento | R$ 82,82 |
| SMA 20 | R$ 82,23 |
| BB Superior | R$ 85,47 |
| BB Inferior | R$ 79,00 |
| Largura BB | **7,9%** (menor dos três) |
| RSI 14 | **49,2** |
| Posição no BB | Levemente acima do centro |

### 3.2 Volume Profile (35 pregões diários — cálculo manual)

Volume total do período: **≈ 666,3 milhões** de ações

#### Distribuição por bin de R$ 1,00

```
Preço      Volume (M)   Barra
─────────────────────────────────────────────────
[77 – 78)     0,3 M    ████ (mínimo absoluto)
[78 – 79)    13,6 M    ████████
[79 – 80)    24,1 M    ███████████████
[80 – 81)    80,2 M    ████████████████████████████████████████████████████
[81 – 82)  ★ 99,1 M    ████████████████████████████████████████████████████████████  ← POC
[82 – 83)    94,0 M    ████████████████████████████████████████████████████████████
[83 – 84)    89,2 M    ████████████████████████████████████████████████████████
[84 – 85)    59,0 M    █████████████████████████████████████
[85 – 86)    50,7 M    ████████████████████████████████
[86 – 87)    34,9 M    ██████████████████████
[87 – 88)    33,8 M    █████████████████████
[88 – 89)    66,8 M    ████████████████████████████████████████████
[89 – 90)    20,6 M    █████████████
─────────────────────────────────────────────────
```

#### Níveis-chave do Volume Profile

| Nível | Preço | Volume | Significado |
|---|---|---|---|
| **POC** | **R$ 81 – 82** | 99,1M | Nível de máximo volume — suporte gravitacional |
| HVN 2 | R$ 82 – 83 | 94,0M | Zona de forte suporte/resistência |
| HVN 3 | R$ 83 – 84 | 89,2M | Zona atual de consolidação |
| HVN 4 | R$ 80 – 81 | 80,2M | Suporte robusto abaixo |
| **VAH** | **~R$ 85 – 86** | — | Value Area High (topo dos 70%) |
| **VAL** | **~R$ 80** | — | Value Area Low (fundo dos 70%) |
| LVN ↑ | R$ 86 – 88 | 34-35M | **Gap de liquidez — preço acelera aqui se romper para cima** |
| LVN ↓ | R$ 78 – 79 | 13,6M | **Gap de liquidez — preço acelera aqui se romper para baixo** |
| HVN antigo | R$ 88 – 89 | 66,8M | Resistência histórica (zona do antigo topo 89,75) |

**Value Area (70% do volume):** R$ 80,00 — R$ 85,90

### 3.3 Confluências BB × Volume Profile

| Nível BB | Nível VP | Confluência |
|---|---|---|
| BB Médio → **R$ 82,23** | POC → **R$ 81–82** | ⭐ **FORTE** — SMA20 e POC no mesmo patamar |
| BB Inferior → **R$ 79,00** | VAL → **R$ 80,00** | ⭐ **FORTE** — suporte duplo na base da VA |
| BB Superior → **R$ 85,47** | VAH → **R$ 85–86** | ⭐ **FORTE** — resistência dupla no topo da VA |
| — | LVN (86–88) | ⚡ Zona de aceleração acima do BB Superior |

### 3.4 Diagnóstico integrado

O Volume Profile confirma e amplifica o Cenário C (squeeze em formação):

1. **Equilíbrio perfeito:** O preço (R$ 82,82) está estacionado **entre o POC (81-82) e o HVN de 83-84**, zona de máxima acumulação de volume. Isso é o comportamento clássico de um mercado em equilíbrio aguardando catalisador.

2. **BB Médio = POC = Equilíbrio estatístico:** A coincidência da SMA20 (82,23) com o POC (81-82) indica que o preço justo de mercado percebido por ambos os métodos é o mesmo patamar. RSI em 49,2 confirma: **nenhuma força direcional dominante.**

3. **LVNs criam assimetria de movimento:**
   - Ruptura **acima de R$ 85,47** (BB Superior / VAH) → entra em LVN (R$ 86-88, apenas 34-35M de volume). Preço pode **acelerar rapidamente** até a zona de HVN antigo: **R$ 88-89** (+6-7% do preço atual)
   - Ruptura **abaixo de R$ 79,00** (BB Inferior / VAL) → entra em LVN (R$ 78-79, apenas 13,6M). Preço pode **despencar rapidamente** até R$ 77-78 (LVN extremo com quase zero volume)

4. **Bandas mais estreitas dos três ativos (7,9%)** com RSI travado em 49,2 = squeeze estatisticamente avançado.

### 3.5 Estratégia: Strangle Comprado (compra de volatilidade)

**Contexto:** Comprar volatilidade barata antes do squeeze estourar. A direção é desconhecida, mas os LVNs garantem que o movimento, quando vier, será **rápido e extenso**.

| Perna | Ação | Strike | Justificativa |
|---|---|---|---|
| Perna CALL | **Compra CALL** | **R$ 85,50** | Acima do BB Superior / VAH — entrada no LVN |
| Perna PUT | **Compra PUT** | **R$ 80,00** | Exatamente no VAL / próximo ao BB Inferior |

- **Ganho máximo (CALL):** alvo R$ 88–89 (HVN antigo) → potencial de +R$ 2,50–3,50 acima do strike
- **Ganho máximo (PUT):** alvo R$ 78–79 (LVN extremo) → potencial de -R$ 1,00–2,00 abaixo do strike
- **Perda máxima:** prêmio total pago (as duas pernas somadas)
- **Ponto de equilíbrio:** preço fora do range [R$ 80 – prêmio total] a [R$ 85,50 + prêmio total]

**Timing crítico (risco Theta):**
> Entrar cedo demais = decaimento temporal corrói os prêmios. O momento ideal é quando as bandas atingirem o mínimo de contração. Observar: se nos próximos 3-5 pregões o range diário for consistentemente < R$ 1,50, a squeeze está no ápice.

**Alternativa mais agressiva — Straddle:**
| Perna | Ação | Strike |
|---|---|---|
| CALL | Compra | R$ 83,00 (ATM) |
| PUT | Compra | R$ 83,00 (ATM) |

- Menor custo de entrada (ATM tem delta mais favorável)
- Funciona se o movimento for ≥ prêmio total para qualquer lado

---

## 4. ALERTAS RECOMENDADOS (configurar manualmente)

| Ativo | Preço | Condição | Mensagem |
|---|---|---|---|
| BBAS3 | R$ 19,98 | Cruzamento ↓ | "Confirmar RSI < 30 — Cenário B — Bull Put Spread" |
| VALE3 | R$ 85,50 | Cruzamento ↑ | "Ruptura VAH/BB Superior — LVN acima — Cenário C bullish" |
| VALE3 | R$ 80,00 | Cruzamento ↓ | "Ruptura VAL/BB Inferior — LVN abaixo — Cenário C bearish" |
| SMAL11 | R$ 107,96 | Cruzamento ↓ | "Confirmar RSI < 30 — Cenário B — Bull Put Spread" |

---

## 5. MAPA DE RISCO

### Risco específico do "Surfe nas Bandas" (BBAS3)
BBAS3 está em **downtrend macroestrutura** (abaixo do P Anual de R$ 23,36 e do P Mensal de R$ 23,50). O Cenário B sinaliza **exaustão da queda**, não reversão de tendência. Portanto:
- Usar **travas** (Bull Put Spread), nunca compra de Put a seco
- O vencimento semanal limita a exposição ao decaimento de IV
- Stop obrigatório: fechamento semanal abaixo de **R$ 18,50**

### Risco do Theta no Strangle (VALE3)
Cada dia sem movimento corrói o valor das opções compradas. O Theta (decaimento temporal) é o principal inimigo da estratégia de compra de volatilidade. Se após 5 pregões o preço não tiver dado sinal de direção, reavaliar ou sair.

### Fator Vega em todos os cenários
- **Cenários A e B** (sell vol): Vega negativo — lucra com colapso de IV após a exaustão. Ideal para travas.
- **Cenário C** (buy vol): Vega positivo — lucra com expansão de IV no breakout. Ideal para straddle/strangle comprado.

---

> ⚠️ **Aviso:** Análise técnica-educacional. Não constitui recomendação de investimento. Calcule os prêmios reais na B3 antes de operar. Confirme liquidez das séries antes de entrar. Parâmetros de RSI e BB calculados manualmente a partir de closes diários — pequenas divergências em relação ao TradingView são esperadas por diferenças de arredondamento.
