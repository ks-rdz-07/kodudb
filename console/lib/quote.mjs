// SQL quoting for console-generated statements.
/** @param {string} name */
export const qi = (name) => `"${String(name).replaceAll('"', '""')}"`
/** @param {string} value */
export const ql = (value) => `'${String(value).replaceAll("'", "''")}'`
