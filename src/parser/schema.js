// Block type constants and JSON schema definitions for the Pine → Block representation.

export const BlockType = {
  ENTRY: 'Entry',
  EXIT: 'Exit',
  FILTER: 'Filter',
  SIZING: 'Sizing',
  INDICATOR: 'Indicator',
  RAW_PINE: 'RawPine',
};

export const ScriptType = {
  STRATEGY: 'strategy',
  INDICATOR: 'indicator',
  LIBRARY: 'library',
};

export const Side = {
  LONG: 'long',
  SHORT: 'short',
  UNKNOWN: 'unknown',
};

/**
 * JSON schema (as JS object) for a ParsedScript.
 *
 * ParsedScript {
 *   version: number          - Pine version (5)
 *   scriptType: ScriptType
 *   name: string             - from strategy/indicator title arg
 *   params: object           - other declaration params (overlay, initial_capital, etc.)
 *   blocks: Block[]
 * }
 *
 * Block union:
 *
 * EntryBlock {
 *   type: 'Entry'
 *   id: string
 *   side: 'long' | 'short' | 'unknown'
 *   label: string            - strategy.entry id string
 *   conditions: string[]     - parsed condition fragments
 *   conditionRaw: string     - raw condition text
 *   qtyExpr: string | null   - quantity expression
 *   sourceLines: [number, number]
 *   rawSource: string
 * }
 *
 * ExitBlock {
 *   type: 'Exit'
 *   id: string
 *   label: string            - strategy.exit id string
 *   fromEntry: string | null - which entry this closes
 *   stopExpr: string | null
 *   limitExpr: string | null
 *   trailExpr: string | null
 *   closeSignal: string | null - condition for strategy.close
 *   sourceLines: [number, number]
 *   rawSource: string
 * }
 *
 * FilterBlock {
 *   type: 'Filter'
 *   id: string
 *   label: string
 *   variableName: string | null
 *   expression: string
 *   sourceLines: [number, number]
 *   rawSource: string
 * }
 *
 * SizingBlock {
 *   type: 'Sizing'
 *   id: string
 *   label: string
 *   method: 'fixed' | 'pct_equity' | 'atr_based' | 'expression'
 *   expression: string
 *   sourceLines: [number, number]
 *   rawSource: string
 * }
 *
 * IndicatorBlock {
 *   type: 'Indicator'
 *   id: string
 *   variableName: string
 *   function: string         - ta.rsi, ta.ema, etc.
 *   args: string[]
 *   expression: string
 *   sourceLines: [number, number]
 *   rawSource: string
 * }
 *
 * RawPineBlock {
 *   type: 'RawPine'
 *   id: string
 *   note: string             - why it wasn't classified
 *   sourceLines: [number, number]
 *   rawSource: string
 * }
 */

export function makeId(type, index) {
  return `${type.toLowerCase()}_${index}`;
}
