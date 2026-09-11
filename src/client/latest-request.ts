/** Responses may commit only while they still own the current request. */
export function createLatestRequest() {
  let generation = 0
  return {
    begin: () => { const current = ++generation; return () => current === generation },
    invalidate: () => { generation++ },
  }
}
