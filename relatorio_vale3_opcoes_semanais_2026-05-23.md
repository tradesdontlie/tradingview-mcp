# VALE3 — Relatório de Análise Gráfica para Opções Semanais
**Data:** 23/05/2026 | **Timeframe:** Semanal | **Preço:** R$ 83,10

---

## 1. CONTEXTO DE MERCADO

| Item | Valor |
|---|---|
| Preço atual | R$ 83,10 |
| Abertura da semana | R$ 83,00 |
| Máxima da semana | R$ 83,60 |
| Mínima da semana | R$ 80,17 |
| Volume semanal | 85,3M (abaixo da média de 113M) |
| Variação 100 semanas | **+37,42%** (de R$ 60,47) |
| Máxima 100 semanas | R$ 91,62 |
| Mínima 100 semanas | R$ 48,77 |

**Contexto macro:** VALE3 está em tendência de alta estrutural no semanal, tendo rompido o Pivot Central anual (P = R$ 64,82) e o R1 anual (R$ 80,88). O papel fez topo em R$ 89,44 há 4 semanas (próximo ao R2 = 89,79), sofreu uma correção abrupta de **-10,9% em uma semana** até R$ 77,97 e está em processo de recuperação. Volume desta semana abaixo da média indica consolidação/indecisão.

---

## 2. NÍVEIS-CHAVE (Pivot Points Standard — Semanal)

### Resistências

| Nível | Preço | Relevância |
|---|---|---|
| Resistência imediata | **R$ 83,60** | Máxima da semana atual |
| P Mensal | **R$ 85,96** | Pivot central mensal — barreira técnica |
| R2 anual | **R$ 86,87** | Confluência com pivot mensal |
| R2 semanal | **R$ 89,79** | Topo recente / resistência principal |
| Máxima histórica (100s) | **R$ 91,62** | Resistência absoluta do período |
| R3 semanal | **R$ 95,56 – 96,66** | Próximo alvo em caso de rompimento |

### Suportes

| Nível | Preço | Relevância |
|---|---|---|
| Suporte imediato | **R$ 80,88** | R1 anual — virou suporte após rompimento |
| Mínima recente | **R$ 77,97** | Fundo da correção de 3 semanas atrás |
| S1 semanal | **R$ 55,91** | Suporte estrutural distante |
| P anual | **R$ 64,82** | Suporte de longo prazo |

---

## 3. VOLATILIDADE SEMANAL

| Métrica | Valor |
|---|---|
| Desvio padrão de retornos (52 semanas) | **3,42%** |
| Desvio padrão em preço | **± R$ 2,85** |
| Retorno médio semanal | **+0,98%** |
| Semana mais extrema | **-10,9%** (spike de volatilidade) |

### Bandas de Probabilidade para a Semana

| Sigma | Intervalo esperado |
|---|---|
| 1σ (68%) | R$ 80,25 — R$ 85,95 |
| 2σ (95%) | R$ 77,40 — R$ 88,80 |

---

## 4. PADRÃO DAS ÚLTIMAS 5 SEMANAS

| Semana | Abertura | Fechamento | Variação | Observação |
|---|---|---|---|---|
| -4 | 88,80 | 85,87 | -3,3% | Topo em 89,44 — rejeição R2 |
| -3 | 86,15 | 81,18 | -5,8% | Queda forte, mínima 79,25 |
| -2 | 81,18 | 81,49 | +0,4% | Suporte em 77,97 — doji |
| -1 | 81,39 | 83,50 | +2,6% | Recuperação — vela de força |
| Atual | 83,00 | 83,10 | +0,1% | Consolidação, vol abaixo da média |

**Leitura:** Após rejeição no R2 (89,79), o papel corrigiu para buscar suporte no R1 (80,88), encontrou fundo em 77,97 e está em processo de recuperação. A semana atual é de consolidação com volume baixo — típico de acumulação antes de próximo movimento.

---

## 5. ESTRATÉGIAS COM OPÇÕES SEMANAIS

> **Premissa:** Opções semanais com vencimento na sexta-feira mais próxima. Greves sugeridas aproximadas — verificar disponibilidade na B3.

---

### ESTRATÉGIA 1 — Trava de Alta com Calls (Bull Call Spread)
**Viés:** Alta moderada | **Cenário:** Rompimento acima de R$ 85,96

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | Compra CALL | R$ 83,00 |
| Perna 2 | Venda CALL | R$ 87,00 |

- **Ganho máximo:** diferença entre strikes menos prêmio pago
- **Perda máxima:** prêmio líquido pago
- **Ponto de equilíbrio:** R$ 83 + prêmio pago
- **Gatilho de entrada:** fechamento semanal acima de R$ 83,60
- **Alvo:** R$ 89,79 (R2 semanal)
- **Stop:** fechamento abaixo de R$ 80,88

---

### ESTRATÉGIA 2 — Venda de Strangle (Short Strangle)
**Viés:** Neutro / Consolidação | **Cenário:** Ativo permanece entre R$ 80 e R$ 87

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | Venda CALL | R$ 87,00 |
| Perna 2 | Venda PUT | R$ 80,00 |

- **Ganho máximo:** prêmio total recebido (ativo fecha entre 80 e 87)
- **Perda máxima:** ilimitada (call) / limitada (put até zero)
- **Break-evens:** abaixo de R$ 80 – prêmio recebido / acima de R$ 87 + prêmio recebido
- **Premissa:** vol semanal de 3,4% mantém o preço dentro do range 1σ
- **Risco principal:** repetição de spike como semana -3 (-10,9%) — use stop em 89,79 e 77,97

---

### ESTRATÉGIA 3 — Trava de Baixa com Puts (Bear Put Spread)
**Viés:** Baixa moderada | **Cenário:** Correção para retestar R1 (80,88)

| Perna | Ação | Strike |
|---|---|---|
| Perna 1 | Compra PUT | R$ 83,00 |
| Perna 2 | Venda PUT | R$ 80,00 |

- **Ganho máximo:** diferença entre strikes menos prêmio pago
- **Perda máxima:** prêmio líquido pago
- **Gatilho de entrada:** rompimento abaixo de R$ 80,17 (mínima semanal atual)
- **Alvo:** R$ 77,97 (fundo da correção recente)
- **Stop:** fechamento acima de R$ 85,96

---

### ESTRATÉGIA 4 — Borboleta com Calls (Call Butterfly)
**Viés:** Neutro — papel permanece próximo de R$ 83

| Perna | Ação | Strike | Qtd |
|---|---|---|---|
| Asa inferior | Compra CALL | R$ 80,00 | 1x |
| Corpo | Venda CALL | R$ 83,00 | 2x |
| Asa superior | Compra CALL | R$ 86,00 | 1x |

- **Ganho máximo:** no vencimento com preço = R$ 83,00
- **Perda máxima:** prêmio líquido pago (custo baixo)
- **Ideal para:** semanas de baixo volume e consolidação
- **Zona de lucro:** R$ 80 a R$ 86

---

## 6. RESUMO DO CENÁRIO E RECOMENDAÇÃO DE VIÉS

| Cenário | Probabilidade Estimada | Estratégia Indicada |
|---|---|---|
| Consolidação (R$ 80–87) | **Alta** (vol baixo, pós-correção) | Strangle / Butterfly |
| Rompimento de alta (> 87) | **Moderada** (tendência de fundo) | Bull Call Spread |
| Nova correção (< 80,17) | **Baixa** (suporte testado e confirmado) | Bear Put Spread |

**Viés predominante:** **Neutro para levemente altista.** O papel encontrou suporte no R1 anual (80,88), está em recuperação com volume baixo. O P mensal (85,96) é a barreira a ser vencida para retomada da tendência em direção a 89,79. Qualquer posição deve respeitar o nível de R$ 80,88 como stop estrutural.

---

> ⚠️ **Aviso:** Este relatório é de natureza técnica e educacional. Não constitui recomendação de investimento. Verifique disponibilidade de strikes e liquidez das opções VALE3 na B3 antes de operar.
