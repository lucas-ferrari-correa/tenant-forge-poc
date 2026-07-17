import { DslParseError, type DslSourcePosition } from './errors.js'

export type TokenKind =
  | 'ident'
  | 'string'
  | 'number'
  | 'true'
  | 'false'
  | 'lbrace'
  | 'rbrace'
  | 'lparen'
  | 'rparen'
  | 'lbrack'
  | 'rbrack'
  | 'eq'
  | 'comma'
  | 'question'
  | 'at'
  | 'atat'
  | 'eof'

export type Token = {
  kind: TokenKind
  value: string
  position: DslSourcePosition
}

export type Lexer = {
  peek: () => Token
  next: () => Token
  source: string
}

function positionAt(source: string, offset: number): DslSourcePosition {
  let line = 1
  let column = 1
  for (let i = 0; i < offset; i += 1) {
    if (source[i] === '\n') {
      line += 1
      column = 1
    } else {
      column += 1
    }
  }
  return { line, column, offset }
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_'
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '_' || ch === '-'
}

export function createLexer(source: string): Lexer {
  let offset = 0
  let lookahead: Token | undefined

  function skipTrivia(): void {
    while (offset < source.length) {
      const ch = source[offset]
      if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
        offset += 1
        continue
      }
      if (ch === '/' && source[offset + 1] === '/') {
        offset += 2
        while (offset < source.length && source[offset] !== '\n') {
          offset += 1
        }
        continue
      }
      break
    }
  }

  function readToken(): Token {
    skipTrivia()
    const start = offset
    const position = positionAt(source, start)

    const ch = source[offset]
    if (ch === undefined) {
      return { kind: 'eof', value: '', position }
    }

    switch (ch) {
      case '{':
        offset += 1
        return { kind: 'lbrace', value: '{', position }
      case '}':
        offset += 1
        return { kind: 'rbrace', value: '}', position }
      case '(':
        offset += 1
        return { kind: 'lparen', value: '(', position }
      case ')':
        offset += 1
        return { kind: 'rparen', value: ')', position }
      case '[':
        offset += 1
        return { kind: 'lbrack', value: '[', position }
      case ']':
        offset += 1
        return { kind: 'rbrack', value: ']', position }
      case '=':
        offset += 1
        return { kind: 'eq', value: '=', position }
      case ',':
        offset += 1
        return { kind: 'comma', value: ',', position }
      case '?':
        offset += 1
        return { kind: 'question', value: '?', position }
      case '@':
        if (source[offset + 1] === '@') {
          offset += 2
          return { kind: 'atat', value: '@@', position }
        }
        offset += 1
        return { kind: 'at', value: '@', position }
      case '"': {
        offset += 1
        let value = ''
        while (offset < source.length && source[offset] !== '"') {
          if (source[offset] === '\\') {
            offset += 1
            const escaped = source[offset]
            if (escaped === undefined) {
              throw new DslParseError('UNEXPECTED_EOF', 'unterminated string escape', position)
            }
            if (escaped === 'n') {
              value += '\n'
            } else if (escaped === 't') {
              value += '\t'
            } else if (escaped === '"' || escaped === '\\') {
              value += escaped
            } else {
              value += escaped
            }
            offset += 1
            continue
          }
          value += source[offset]
          offset += 1
        }
        if (offset >= source.length) {
          throw new DslParseError('UNEXPECTED_EOF', 'unterminated string', position)
        }
        offset += 1
        return { kind: 'string', value, position }
      }
      default:
        break
    }

    const nextCh = source[offset + 1]
    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '-' && nextCh !== undefined && nextCh >= '0' && nextCh <= '9')
    ) {
      let end = offset + 1
      while (end < source.length) {
        const digit = source[end]
        if (digit === undefined || digit < '0' || digit > '9') {
          break
        }
        end += 1
      }
      if (source[end] === '.') {
        end += 1
        while (end < source.length) {
          const digit = source[end]
          if (digit === undefined || digit < '0' || digit > '9') {
            break
          }
          end += 1
        }
      }
      const value = source.slice(offset, end)
      offset = end
      return { kind: 'number', value, position }
    }

    if (isIdentStart(ch)) {
      let end = offset + 1
      while (end < source.length && isIdentPart(source[end] ?? '')) {
        end += 1
      }
      const value = source.slice(offset, end)
      offset = end
      if (value === 'true') {
        return { kind: 'true', value, position }
      }
      if (value === 'false') {
        return { kind: 'false', value, position }
      }
      return { kind: 'ident', value, position }
    }

    throw new DslParseError('UNEXPECTED_TOKEN', `unexpected character "${ch}"`, position)
  }

  return {
    source,
    peek(): Token {
      if (lookahead === undefined) {
        lookahead = readToken()
      }
      return lookahead
    },
    next(): Token {
      if (lookahead !== undefined) {
        const token = lookahead
        lookahead = undefined
        return token
      }
      return readToken()
    },
  }
}
