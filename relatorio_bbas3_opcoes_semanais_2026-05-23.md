# BBAS3 — Relatório de Análise Gráfica para Opções Semanais
**Data:** 23/05/2026 | **Timeframe:** Semanal | **Preço:** R$ 20,94

---

## 1. CONTEXTO DE MERCADO

| Item | Valor |
|---|---|
| Preço atual | R$ 20,94 |
| Abertura da semana | R$ 20,70 |
| Máxima da semana | R$ 21,05 |
| Mínima da semana | R$ 20,07 |
| Volume semanal | 133,4M (abaixo da média de 148,4M) |
| Variação 100 semanas | **-21,6%** (de R$ 26,71) |
| Máxima 100 semanas | R$ 30,04 |
| Mínima 100 semanas | R$ 18,12 |

**Contexto macro:** BBAS3 apresenta uma das estruturas mais complexas do período: fez topo em R$ 30,04 (maio/2025), colapsou **-39,7%** até R$ 18,12 (julho/2025), recuperou até R$ 27,81 (novembro/2025), e voltou a ceder para R$ 20,94 — abaixo do P Anual (R$ 23,36) e do P Mensal (R$ 23,50). O papel está em downtrend de médio prazo desde novembro/2025. A semana atual mostra tentativa de recuperação acima do P Semanal (R$ 20,76), único pivot acima do preço atual.

---

## 2. NÍVEIS-CHAVE (Pivot Points Standard — Semanal)

### Resistências

| Nível | Preço | Relevância |
|---|---|---|
| Máxima semanal atual | **R$ 21,05** | Teto da semana em curso |
| S1 mensal (virou resistência) | **R$ 21,51** | Suporte mensal perdido — agora barreira |
| R1 semanal | **R$ 21,78** | Primeira resistência pivot |
| R2 semanal / R3 | **R$ 22,87** | Zona de resistência técnica |
| P anual | **R$ 23,36** | Resistência estrutural — nível de virada |
| P mensal | **R$ 23,50** | Confluência com P anual |
| R1 mensal | **R$ 24,68** | Alvo em caso de recuperação forte |
| Máxima histórica (100s) | **R$ 30,04** | Topo absoluto do período |

### Suportes

| Nível | Preço | Relevância |
|---|---|---|
| P semanal | **R$ 20,76** | Pivot central semanal — suporte imediato |
| Mínima semanal atual | **R$ 20,07** | Fundo da semana em curso |
| Mínima semana anterior | **R$ 19,74** | Suporte recente crítico |
| S1 semanal | **R$ 19,67** | Confluência com mínima anterior |
| S2 semanal | **R$ 18,65** | Zona de suporte estrutural |
| Mínima 52 semanas | **R$ 18,35** | Fundo do colapso (julho/2025) |
| Mínima absoluta (100s) | **R$ 18,12** | Suporte máximo do período |
| S1 anual | **R$ 16,68** | Suporte de longo prazo distante |

---

## 3. VOLATILIDADE SEMANAL

| Métrica | Valor |
|---|---|
| Desvio padrão de retornos (52 semanas) | **4,50%** |
| Desvio padrão em preço | **± R$ 0,94** |
| Retorno médio semanal | **-0,31%** |
| Semana mais extrema positiva | **+13,62%** (spike de recuperação — julho/2025) |
| Semana mais extrema negativa | **-9,34%** (colapso de julho/2025) |

> BBAS3 tem a maior volatilidade semanal entre os três ativos analisados, reflexo dos eventos extremos de 2025 (queda de -39,7% e recuperação de +53,5%).

### Bandas de Probabilidade para a Semana

| Sigma | Intervalo esperado |
|---|---|
| 1σ (68%) | R$ 20,00 — R$ 21,88 |
| 2σ (95%) | R$ 19,06 — R$ 22,82 |

---

## 4. PADRÃO DAS ÚLTIMAS 5 SEMANAS

| Semana | Abertura | Fechamento | Variação | Observação |
|---|---|---|---|---|
| -4 | 24,57 | 24,40 | -0,7% | Topo da recuperação — rejeição próximo ao P mensal |
| -3 | 24,40 | 22,70 | **-7,0%** | Queda forte, rompimento da S1 mensal |
| -2 | 22,72 | 22,21 | -2,2% | Continuação do declínio, vol baixo |
| -1 | 22,21 | 21,80 | -1,8% | Queda persistente, menor força |
| Ant. | 21,77 | 20,70 | **-4,9%** | Aceleração, volume alto (173M) — novo fundo |
| Atual | 20,70 | 20,94 | +1,2% | Tentativa de recuperação acima do P semanal |

**Leitura:** Cinco semanas consecutivas de queda desde a máxima de R$ 24,57. A semana -3 foi a mais impactante (-7,0%), rompendo a S1 mensal (R$ 21,51). A semana anterior à atual teve o maior volume (173,4M) — podendo indicar capitulação ou distribuição. A semana atual mostra leve recuperação, mas sem romper resistências relevantes. O preço está aprisionado entre o P Semanal (R$ 20,76) e a máxima semanal (R$ 21,05).

---

## 5. ESTRATÉGIAS COM OPÇÕES SEMANAIS

> **Premissa:** Opções semanais com vencimento na sexta-feira mais próxima. Greves sugeridas aproximadas — verificar disponibilidade na B3.

---

### ESTRATÉGIA 1 — Trava de Baixa com Puts (Bear Put Spread)
**Viés:** Baixa moderada | **Cenário:** Falha em reconquistar a S1 mensal (21,51) e nova queda

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | Compra PUT | R$ 21,00 |
| Perna 2 | Venda PUT | R$ 19,50 |

- **Ganho máximo:** diferença entre strikes menos prêmio pago
- **Perda máxima:** prêmio líquido pago
- **Gatilho de entrada:** fechamento abaixo do P semanal (R$ 20,76)
- **Alvo:** R$ 19,74 (mínima recente) / R$ 19,67 (S1 semanal)
- **Stop:** fechamento semanal acima de R$ 21,51 (S1 mensal)

---

### ESTRATÉGIA 2 — Venda de Strangle (Short Strangle)
**Viés:** Neutro / Consolidação | **Cenário:** Ativo permanece entre R$ 19,50 e R$ 22,00

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | Venda CALL | R$ 22,00 |
| Perna 2 | Venda PUT | R$ 19,50 |

- **Ganho máximo:** prêmio total recebido (ativo fecha entre 19,50 e 22,00)
- **Perda máxima:** ilimitada (call) / limitada (put até zero)
- **Break-evens:** abaixo de R$ 19,50 – prêmio / acima de R$ 22,00 + prêmio
- **Premissa:** vol semanal de 4,5% contém range 1σ em R$ 20,00 — R$ 21,88
- **Risco principal:** rompimento do fundo de R$ 18,12 ou recuperação acima de R$ 23,36 (P anual)

---

### ESTRATÉGIA 3 — Trava de Alta com Calls (Bull Call Spread)
**Viés:** Alta moderada | **Cenário:** Retomada acima da S1 mensal em direção ao P anual

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | Compra CALL | R$ 21,00 |
| Perna 2 | Venda CALL | R$ 23,50 |

- **Ganho máximo:** diferença entre strikes menos prêmio pago
- **Perda máxima:** prêmio líquido pago
- **Gatilho de entrada:** fechamento semanal acima de R$ 21,51 (S1 mensal)
- **Alvo:** R$ 23,36 (P anual) / R$ 23,50 (P mensal)
- **Stop:** fechamento abaixo de R$ 20,07 (mínima semanal atual)

---

### ESTRATÉGIA 4 — Borboleta com Puts (Put Butterfly)
**Viés:** Neutro — papel consolida próximo de R$ 20,50-21,00

| Perna | Ação | Strike | Qtd |
|---|---|---|---|
| Asa superior | Compra PUT | R$ 22,00 | 1x |
| Corpo | Venda PUT | R$ 20,50 | 2x |
| Asa inferior | Compra PUT | R$ 19,00 | 1x |

- **Ganho máximo:** vencimento com preço ≈ R$ 20,50
- **Perda máxima:** prêmio líquido pago (custo baixo)
- **Ideal para:** continuação da consolidação no suporte, sem movimento direcional
- **Zona de lucro:** R$ 19,00 a R$ 22,00

---

## 6. RESUMO DO CENÁRIO E RECOMENDAÇÃO DE VIÉS

| Cenário | Probabilidade Estimada | Estratégia Indicada |
|---|---|---|
| Continuação da queda (< 19,67) | **Moderada** (5 semanas de baixa, abaixo dos pivots anuais) | Bear Put Spread |
| Consolidação (R$ 19,50 — R$ 22,00) | **Alta** (suporte histórico 18,12, 1σ contém o range) | Strangle / Butterfly |
| Recuperação (> 21,51) | **Baixa** (exige superar múltiplas resistências pivot) | Bull Call Spread |

**Viés predominante:** **Baixista para neutro.** BBAS3 é o ativo mais fraco dos três analisados nesta semana — está abaixo do P Anual (23,36) e do P Mensal (23,50), em downtrend de médio prazo desde novembro/2025. A recuperação exige, como mínimo, reconquistar o P Anual. O suporte crítico absoluto é a mínima de R$ 18,12 — abaixo deste nível, o cenário estrutural torna-se fortemente baixista. A tentativa de recuperação da semana atual (acima de R$ 20,76) precisa de confirmação com fechamento acima de R$ 21,51.

---

> ⚠️ **Aviso:** Este relatório é de natureza técnica e educacional. Não constitui recomendação de investimento. Verifique disponibilidade de strikes e liquidez das opções BBAS3 na B3 antes de operar.
