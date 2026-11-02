'use client'
// SQL editor with IntelliSense: Postgres keywords, live schema (tables, columns), common functions, Ctrl/Cmd+Enter to run.
import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { PostgreSQL, sql as sqlLang, type SQLNamespace } from '@codemirror/lang-sql'
import { completeFromList } from '@codemirror/autocomplete'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { sql } from '@/lib/api'

const FUNCTIONS = [
  ['now()', 'current timestamp'], ['auth.uid()', 'id of the signed-in user'], ['auth.role()', 'role from the request token'],
  ['auth.jwt()', 'claims of the request token'], ['gen_random_uuid()', 'random UUID'], ['count(*)', 'aggregate'],
  ['coalesce(a, b)', 'first non-null'], ['jsonb_build_object(k, v)', 'build JSON'], ['jsonb_agg(x)', 'aggregate to JSON array'],
  ['date_trunc(\'day\', ts)', 'truncate a timestamp'], ['string_agg(x, \', \')', 'join strings'], ['array_agg(x)', 'aggregate to array'],
  ['round(x, 2)', 'round a number'], ['lower(text)', 'lower case'], ['extract(epoch from ts)', 'seconds since 1970'],
].map(([label, detail]) => ({ label, detail, type: 'function', apply: label }))

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--accent-11)', fontWeight: '500' },
  { tag: [t.string, t.special(t.string)], color: 'var(--grass-11)' },
  { tag: [t.number, t.bool, t.null], color: 'var(--blue-11)' },
  { tag: t.comment, color: 'var(--gray-10)', fontStyle: 'italic' },
  { tag: [t.typeName, t.standard(t.name)], color: 'var(--amber-11)' },
  { tag: [t.operator, t.punctuation], color: 'var(--gray-11)' },
])

const theme = EditorView.theme({
  '&': { fontSize: '13px', backgroundColor: 'transparent', color: 'var(--gray-12)' },
  '.cm-content': { fontFamily: 'var(--code-font-family)', padding: '10px 0', caretColor: 'var(--accent-9)' },
  '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--gray-9)', border: 'none', fontFamily: 'var(--code-font-family)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--gray-a2)' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--accent-a4) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent-9)' },
  '.cm-tooltip': { border: '1px solid var(--gray-a5)', backgroundColor: 'var(--color-panel-solid)', borderRadius: '8px', boxShadow: 'var(--shadow-4)', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--code-font-family)', fontSize: '12.5px', maxHeight: '240px' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important', color: 'var(--gray-12)' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-a4)', color: 'var(--gray-12)' },
  '.cm-completionDetail': { color: 'var(--gray-10)', fontStyle: 'normal', marginLeft: '10px' },
  '.cm-completionIcon': { opacity: '0.7' },
  '.cm-matchingBracket': { backgroundColor: 'var(--accent-a3)', outline: 'none' },
})

/** Loads table and column names once per mount for completion. */
export function useSchema(): SQLNamespace {
  const [schema, setSchema] = useState<SQLNamespace>({})
  useEffect(() => {
    sql(`select table_schema, table_name, column_name from information_schema.columns
         where table_schema in ('public', 'auth', 'storage', 'history') order by table_schema, table_name, ordinal_position`).then(
      (r) => {
        const ns: Record<string, Record<string, string[]>> = {}
        for (const [s, tbl, col] of r.rows as string[][]) ((ns[s] ??= {})[tbl] ??= []).push(col)
        setSchema(ns)
      },
      () => setSchema({}),
    )
  }, [])
  return schema
}

export function SqlEditor({ value, onChange, onRun, schema, height = '260px', label }: {
  value: string; onChange: (v: string) => void; onRun?: () => void; schema: SQLNamespace; height?: string; label: string
}) {
  const runRef = useRef(onRun)
  runRef.current = onRun
  const extensions = useMemo(() => [
    sqlLang({ dialect: PostgreSQL, schema, defaultSchema: 'public', upperCaseKeywords: false }),
    PostgreSQL.language.data.of({ autocomplete: completeFromList(FUNCTIONS) }),
    syntaxHighlighting(highlight),
    Prec.highest(keymap.of([{ key: 'Mod-Enter', run: () => { runRef.current?.(); return true } }])),
    EditorView.contentAttributes.of({ 'aria-label': label }),
  ], [schema, label])

  return (
    <div className="kd-editor">
      <CodeMirror
        value={value}
        onChange={onChange}
        height={height}
        theme={theme}
        extensions={extensions}
        basicSetup={{ lineNumbers: true, foldGutter: false, highlightActiveLine: true, autocompletion: true, bracketMatching: true, closeBrackets: true }}
      />
    </div>
  )
}
