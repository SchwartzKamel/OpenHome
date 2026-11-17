import { RemoteError } from './errors'
import frozen from './wire-schema.json'
import type { WireTypes } from './wire-types'

export interface Schema {
  $ref?: string
  type?: string
  const?: unknown
  enum?: readonly unknown[]
  oneOf?: readonly Schema[]
  allOf?: readonly Schema[]
  required?: readonly string[]
  properties?: Readonly<Record<string, Schema | undefined>>
  additionalProperties?: boolean
  items?: Schema
  minItems?: number
  maxItems?: number
  uniqueItems?: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  format?: string
  contentEncoding?: string
  maxProperties?: number
}

const definitions: Readonly<Record<string, Schema>> = frozen.definitions

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function bad(path: string): never {
  throw new RemoteError('protocol_error', `Invalid frozen v1 value at ${path || '/'}`)
}

export function validate(schema: Schema, value: unknown, path = ''): void {
  if (schema.$ref) {
    const referenced = definitions[schema.$ref]
    if (!referenced) bad(path)
    validate(referenced, value, path)
    if ((schema.$ref === 'VaultETag' || schema.$ref === 'TradeETag') && typeof value === 'string') {
      if (!Number.isSafeInteger(Number(value.slice(value.indexOf('-') + 1, -1)))) bad(path)
    }
    return
  }
  if ('const' in schema && value !== schema.const) bad(path)
  if (schema.enum && !schema.enum.includes(value)) bad(path)
  if (schema.oneOf) {
    let matches = 0
    for (const option of schema.oneOf) {
      try {
        validate(option, value, path)
        matches++
      } catch (error) {
        if (!(error instanceof RemoteError)) throw error
      }
    }
    if (matches !== 1) bad(path)
  }
  for (const part of schema.allOf ?? []) validate(part, value, path)
  if (schema.type === 'null' && value !== null) bad(path)
  if (schema.type === 'boolean' && typeof value !== 'boolean') bad(path)
  if (schema.type === 'string') {
    if (typeof value !== 'string') bad(path)
    if (schema.maxLength !== undefined && value.length > schema.maxLength * 2) bad(path)
    const length = schema.contentEncoding === 'base64' ? value.length : Array.from(value).length
    if (schema.minLength !== undefined && length < schema.minLength) bad(path)
    if (schema.maxLength !== undefined && length > schema.maxLength) bad(path)
    if (schema.contentEncoding === 'base64') {
      // The equivalent quartet regex overflows the JS regexp stack for valid 16 MiB saves.
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
      if (
        value.length % 4 !== 0 ||
        /[^A-Za-z0-9+/]/u.test(value.slice(0, value.length - padding))
      ) {
        bad(path)
      }
    } else if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) bad(path)
    if (
      schema.format === 'date-time' &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
        !Number.isFinite(Date.parse(value)))
    )
      bad(path)
  }
  if (schema.type === 'integer' || schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) bad(path)
    if (schema.type === 'integer' && !Number.isSafeInteger(value)) bad(path)
    if (schema.minimum !== undefined && value < schema.minimum) bad(path)
    if (schema.maximum !== undefined && value > schema.maximum) bad(path)
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) bad(path)
    if (schema.minItems !== undefined && value.length < schema.minItems) bad(path)
    if (schema.maxItems !== undefined && value.length > schema.maxItems) bad(path)
    if (
      schema.uniqueItems &&
      new Set(value.map((item) => JSON.stringify(item))).size !== value.length
    ) {
      bad(path)
    }
    const items = schema.items
    if (items) {
      value.forEach((item, index) => validate(items, item, `${path}/${index}`))
    }
  }
  if (schema.type === 'object' || schema.required) {
    if (!isObject(value)) bad(path)
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) bad(`${path}/${name}`)
    }
    if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties)
      bad(path)
    for (const [name, member] of Object.entries(value)) {
      const property =
        schema.properties && Object.hasOwn(schema.properties, name)
          ? schema.properties[name]
          : undefined
      if (property) validate(property, member, `${path}/${name}`)
      else if (schema.additionalProperties === false) bad(`${path}/${name}`)
    }
  }
}

export function parseWire<N extends keyof WireTypes>(name: N, value: unknown): WireTypes[N] {
  validate({ $ref: name }, value)
  return value as WireTypes[N]
}

// JSON.parse alone silently accepts duplicate keys and unpaired surrogate escapes.
export function parseJson(text: string): unknown {
  let position = 0
  const whitespace = () => {
    while (/[ \r\n\t]/.test(text[position] ?? '\0')) position++
  }
  function string(): string {
    const start = position++
    while (position < text.length) {
      const character = text[position++]
      if (character === '\\') position++
      else if (character === '"') {
        const parsed: unknown = JSON.parse(text.slice(start, position))
        if (
          typeof parsed !== 'string' ||
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(parsed)
        ) {
          bad('/json/string')
        }
        return parsed
      }
    }
    return bad('/json/string')
  }
  function value(depth: number): unknown {
    if (depth > 64) bad('/json/depth')
    whitespace()
    const next = text[position]
    if (next === '"') return string()
    if (next === '{' || next === '[') {
      const object = next === '{'
      const end = object ? '}' : ']'
      position++
      whitespace()
      const result: Record<string, unknown> = Object.create(null)
      const list: unknown[] = []
      const names = new Set<string>()
      if (text[position] !== end) {
        for (;;) {
          whitespace()
          if (object) {
            if (text[position] !== '"') bad('/json/key')
            const name = string()
            if (names.has(name)) bad('/json/duplicate-key')
            names.add(name)
            whitespace()
            if (text[position++] !== ':') bad('/json/colon')
            result[name] = value(depth + 1)
          } else list.push(value(depth + 1))
          whitespace()
          if (text[position] !== ',') break
          position++
        }
      }
      if (text[position++] !== end) bad('/json/end')
      return object ? result : list
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(position)
    )?.[0]
    if (!token) bad('/json/value')
    position += token.length
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) bad('/json/number')
    return parsed
  }
  try {
    const parsed = value(0)
    whitespace()
    if (position !== text.length) bad('/json/trailing-data')
    return parsed
  } catch (error) {
    if (error instanceof RemoteError) throw error
    return bad('/json')
  }
}
