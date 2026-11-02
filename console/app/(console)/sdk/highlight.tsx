// Light syntax colouring for the SDK samples: comments, strings, numbers and keywords. Colours match the SQL editor.
// shortcut: a regex tokenizer, not a parser; good enough for short samples, swap for CodeMirror languages if samples grow.
const KEYWORDS = new Set(`
  async await break case catch class const continue def default do elif else elsif end except export false finally for
  from func function go if import in interface let new nil None not null package private public return select static
  struct switch this throw True true try type using var void while with yield begin commit create table insert into
  values update delete set where and or on as policy enable alter grant to returns language plpgsql trigger execute
  primary key references bigint text integer boolean timestamptz numeric uuid float double int bool String char auto
`.trim().split(/\s+/))

const COLORS = { comment: 'var(--gray-10)', string: 'var(--grass-11)', number: 'var(--blue-11)', keyword: 'var(--accent-11)' }

/** Comment syntax per sample language: `--` for SQL, `#` for Python, `//` and block comments for the C family. */
const COMMENT = { sql: /--[^\n]*/, python: /#[^\n]*/, c: /\/\/[^\n]*|\/\*[\s\S]*?\*\// }
const REST = /("""[\s\S]*?"""|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`[^`]*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)\b/
function pattern(lang: string) {
  const comment = lang === 'sql' ? COMMENT.sql : lang === 'python' || lang === 'micropython' ? COMMENT.python : COMMENT.c
  return new RegExp(`(${comment.source})|${REST.source}`, 'g')
}

export function highlight(code: string, lang: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of code.matchAll(pattern(lang))) {
    const kind = m[1] ? 'comment' : m[2] ? 'string' : m[3] ? 'number' : KEYWORDS.has(m[4]) ? 'keyword' : null
    if (!kind) continue
    out.push(code.slice(last, m.index))
    out.push(<span key={m.index} style={{ color: COLORS[kind], fontStyle: kind === 'comment' ? 'italic' : undefined }}>{m[0]}</span>)
    last = m.index + m[0].length
  }
  out.push(code.slice(last))
  return out
}
