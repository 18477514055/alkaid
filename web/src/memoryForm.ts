/** Optional blank form fields are absent, not invalid empty structured-record values.
 * Nonempty text is preserved byte-for-byte; required fields remain enforced by the server.
 */
export function serializeMemoryForm(content: object): string {
  return JSON.stringify(Object.fromEntries(Object.entries(content).filter(([, value]) =>
    value !== undefined && !(typeof value === 'string' && !value.trim()),
  )));
}
