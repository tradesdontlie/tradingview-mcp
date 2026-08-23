# RSI + Bollinger Bands — Análise Quantitativa para Opções
**Data:** 23/05/2026 | **Timeframe:** Diário (1D) | **Ativos:** BBAS3 · SMAL11 · VALE3

> Metodologia: BB(20, 2σ) + RSI(14, Wilder). Sinal válido somente quando **ambos** os indicadores estão em zona extrema simultaneamente.

---

## MAPA DE SINAIS

| Ativo | Preço | BB Superior | BB Médio | BB Inferior | RSI | Cenário | Status |
|---|---|---|---|---|---|---|---|
| **BBAS3** | R$ 20,94 | R$ 22,93 | R$ 21,46 | R$ 19,99 | **32** ↑ | **B — Sobrevendido** | 🔴 **DISPAROU** (há 3 dias) |
| **SMAL11** | R$ 111,50 | R$ 120,41 | R$ 114,37 | R$ 108,33 | **42** | Neutro | 🟡 Em desenvolvimento |
| **VALE3** | R$ 83,10 | R$ 86,27 | R$ 82,21 | R$ 78,15 | **52** | **C — Squeeze** | 🟡 Monitorar explosão |

---

## BBAS3 — 🔴 CENÁRIO B (Disparado)

### Diagnóstico

```
BB Inferior:  R$ 19,99   ← mínima de 19,74 tocou ABAIXO da banda em 15/mai
BB Médio:     R$ 21,46
BB Superior:  R$ 22,93
Preço atual:  R$ 20,94   (entre BI e BM, em recuperação)

RSI atual:    32 ↑        (recuperando de mínima de 18 em 19-20/mai)
```

**O sinal de Cenário B disparou em 19-20/mai/2026:**
- 15/mai: mínima intraday de R$ 19,74 (abaixo da BB Inferior) com fechamento em R$ 20,76
- 19/mai: fechamento em R$ 20,42 com RSI = **18** (extremo sobrevendido)
- 20/mai: fechamento em R$ 20,23 — RSI ainda em 18-20
- A reversão começou em 21/mai: +R$ 0,47 em um dia (RSI sobe para ~27)
- Hoje (23/mai): R$ 20,94, RSI = 32 — **reversão em andamento**

**Interpretação quantitativa:** O RSI atingiu zona de pânico extremo (18), nível raramente sustentado. As Bandas de Bollinger absorveram o teste. A Volatilidade Implícita (IV) inflou fortemente no pânico — o momento de vender volatilidade cara já passou, mas a reversão confirma o colapso do prêmio.

### Largura das Bandas: 13,7%
Bandas amplas após o choque → IV ainda elevada → prêmio de opções ainda gordo.

### Estratégias Indicadas (ordem de prioridade)

**1. Bull Put Spread (entrada ideal foi há 2-3 dias — ainda possível)**
Vender volatilidade capturando o colapso de IV + Theta favorável:

| Perna | Ação | Strike | Lógica |
|---|---|---|---|
| Venda PUT | Crédito | R$ 20,50 | Put cara pelo pânico — IV alta |
| Compra PUT | Proteção | R$ 19,00 | Abaixo do suporte da BB Inferior |

- **Crédito recebido:** ~80% da largura da trava
- **Lucro máximo:** se BBAS3 fechar ≥ R$ 20,50 no vencimento
- **Perda máxima:** limitada pela compra de proteção em 19,00
- **Stop técnico:** fechamento abaixo de R$ 19,74 (mínima recente)
- **Premissa:** RSI saindo de 18 confirma exaustão vendedora — reverte para a média (BB Médio = 21,46)

**2. Short Strangle (se quiser capturar Theta sem direcionalidade)**

| Perna | Ação | Strike |
|---|---|---|
| Venda CALL | Crédito | R$ 22,50 (próximo à BB Superior) |
| Venda PUT | Crédito | R$ 19,50 (abaixo da BB Inferior) |

- Range esperado (1σ): R$ 20,00 — R$ 21,88
- IV alta = prêmios maiores = crédito mais gordo
- **Risco:** novo choque abaixo de R$ 18,12 (mínima absoluta)

### O que acompanhar agora
- ✅ RSI cruzando 40 = confirmação da reversão, pressão de alta aumentando
- ✅ Preço fechando acima de R$ 21,46 (BB Médio) = primeira meta da reversão
- ⚠️ Fechamento abaixo de R$ 19,74 = sinal falso, saída imediata

---

## SMAL11 — 🟡 CENÁRIO B EM DESENVOLVIMENTO (Não Confirmado)

### Diagnóstico

```
BB Inferior:  R$ 108,33   ← preço está 2,9% acima
BB Médio:     R$ 114,37
BB Superior:  R$ 120,41
Preço atual:  R$ 111,50   (na metade inferior das bandas)

RSI atual:    42           (neutro — NÃO está abaixo de 30)
```

**Status: Sinal NÃO disparado.** O RSI (42) não atingiu a zona de exaustão (< 30) e o preço ainda está 2,9% acima da Banda Inferior. Ambas as condições precisam ser atingidas simultaneamente.

**Aproximação do sinal:** SMAL11 se aproxima da zona crítica:
- Nos últimos 5 dias o preço caiu de R$ 117,29 → R$ 111,50 (-5,0%)
- A Banda Inferior em R$ 108,33 é apenas R$ 3,17 abaixo do preço atual
- Se a queda continuar mais 2-3 dias fortes, o RSI pode romper 30

### Largura das Bandas: 10,6%
Bandas moderadas — não há squeeze nem explosão em andamento.

### O Gatilho: O que precisa acontecer para o sinal disparar

```
Condição A: Fechamento ≤ R$ 108,33 (BB Inferior)
Condição B: RSI(14) ≤ 30
Ambas juntas: SINAL B → Bull Put Spread
```

**Zona crítica de monitoramento:** R$ 108,00 — R$ 110,00

### Estratégia de Antecipação (se e somente se o sinal disparar)

**Bull Put Spread (aguardar o gatilho)**

| Perna | Ação | Strike |
|---|---|---|
| Venda PUT | Crédito | R$ 110,00 |
| Compra PUT | Proteção | R$ 107,00 |

- Só entrar se: SMAL11 fechar ≤ R$ 108,33 com RSI ≤ 30
- **Não antecipar o sinal** — o preço pode continuar caindo

### O que acompanhar agora
- 🔍 RSI diário: se cair abaixo de 35, o sinal está próximo
- 🔍 Preço de R$ 108,33: nível de alerta máximo
- ✅ Se RSI < 30 + preço ≤ 108,33: entrar Bull Put Spread imediatamente
- 🛑 Abaixo de R$ 105,73 (P Anual semanal): risco aumentado — não operar

---

## VALE3 — 🟡 CENÁRIO C: SQUEEZE (Monitorar Explosão)

### Diagnóstico

```
BB Inferior:  R$ 78,15
BB Médio:     R$ 82,21
BB Superior:  R$ 86,27
Preço atual:  R$ 83,10   (ACIMA do BB Médio — único dos 3 acima da média)

RSI atual:    52           (neutro, perto de 50 — indecisão)
```

**Status: Cenário C — Squeeze em formação.** VALE3 não está em zona extrema de RSI nem tocando as bandas. Mas apresenta o padrão clássico de pré-explosão:

1. **Bandas se estreitando:** largura de apenas **9,9%** (menor dos 3 ativos)
2. **RSI aprisionado perto de 50:** indica acumulação sem direcionalidade clara
3. **Preço acima da BB Média:** viés levemente altista no curto prazo

**Sequência recente:** VALE3 fez topo em R$ 89,44 (semanas atrás), corrigiu para R$ 77,97, e está consolidando entre R$ 81-83. As bandas se fecharam com essa consolidação — típico precursor de breakout.

### Largura das Bandas: 9,9%
Menor dos 3 ativos → compressão de volatilidade → risco de explosão direcional.

### Estratégia para Cenário C

**Straddle ou Strangle Comprado (especulação direcional)**

| Perna | Ação | Strike | Vencimento |
|---|---|---|---|
| Compra CALL | Debit | R$ 83,00 (ATM) | Próximo semanal |
| Compra PUT | Debit | R$ 83,00 (ATM) | Próximo semanal |

- **Ganho:** qualquer movimento forte para qualquer lado > custo das opções
- **Perda máxima:** prêmio pago nas duas pernas
- **Condição necessária:** as bandas precisam estar estreitas (< 10%) — ✅ confirmado
- **Atenção ao Vega:** comprar volatilidade quando IV está baixa (bands estreitas = IV baixa). Não usar se IV já estiver alta.

**Alternativa: Strangle Comprado (mais barato, precisa de movimento maior)**

| Perna | Ação | Strike |
|---|---|---|
| Compra CALL | Debit | R$ 85,00 (OTM) |
| Compra PUT | Debit | R$ 81,00 (OTM) |

### Sinalizadores de Direção do Breakout

**Breakout Altista (probabilidade maior, dado RSI 52 e preço acima da BB Média):**
- Trigger: fechamento diário > R$ 86,27 (BB Superior) com RSI > 55
- Alvo: R$ 89,44 (topo recente) → R$ 91,62 (máxima 100 semanas)

**Breakout Baixista:**
- Trigger: fechamento diário < R$ 78,15 (BB Inferior) com RSI < 40
- Alvo: R$ 77,97 (fundo da correção recente) → R$ 74,84 (S1 anual semanal)

### O que acompanhar agora
- 🔍 Largura das bandas: se estreitar abaixo de 8% = squeeze confirmado, hora de montar straddle
- 🔍 Volume: explosão de volume com fechamento fora das bandas = breakout real
- 🔍 RSI: rompimento acima de 60 com price action acima do BB Superior = direcional altista

---

## RESUMO EXECUTIVO

| | BBAS3 | SMAL11 | VALE3 |
|---|---|---|---|
| **Cenário** | B (Disparado) | Neutro/Desenvolvendo | C (Squeeze) |
| **RSI** | 32 ↑ (foi 18) | 42 | 52 |
| **Posição vs BB** | Metade inferior | Metade inferior | Acima da média |
| **Largura das Bandas** | 13,7% (ampla) | 10,6% | **9,9% (estreita)** |
| **IV Implícita** | Alta (pós-pânico) | Moderada | **Baixa (squeeze)** |
| **Ação imediata** | Bull Put Spread | Aguardar gatilho | Montar Straddle |
| **Maior risco** | Novo choque < 18,12 | BB Inferior em 108,33 | Decay de tempo |

### Regras de Ouro para Esses 3 Ativos Esta Semana

1. **BBAS3:** Vender volatilidade cara (pós-pânico). O momento foi há 3 dias, mas ainda é possível com strikes conservadores (Bull Put 20,50/19,00). Não comprar opções — IV está cara.

2. **SMAL11:** Paciência. O sinal ainda não disparou. Monitorar diariamente. Entrar só com RSI < 30 + fechamento ≤ 108,33. Entrar antes é especular contra o sistema.

3. **VALE3:** Fazer o oposto do BBAS3 — **comprar** volatilidade barata antes da explosão. O Straddle/Strangle é a aposta certa quando as bandas estão estreitas e o RSI está no meio do campo. A direção do rompimento determinará qual perna lucra.

---

> ⚠️ **Aviso:** Análise técnico-quantitativa de caráter educacional. Não constitui recomendação de investimento. RSI e Bollinger Bands são indicadores de probabilidade, não de certeza. Verifique IV (Volatilidade Implícita) real das opções antes de montar qualquer estrutura.
