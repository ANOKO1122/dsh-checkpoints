/** Never turn a partial image load into a silently text-only resend. */
export async function loadRequiredImages<T, R>(
  refs: readonly T[],
  load: (ref: T) => Promise<R>,
  dispose: (image: R) => void,
): Promise<R[]> {
  const results = await Promise.allSettled(refs.map(load))
  const images: R[] = []
  let failed = 0
  for (const result of results) {
    if (result.status === 'fulfilled') images.push(result.value)
    else failed++
  }
  if (failed) {
    images.forEach(dispose)
    throw new Error(`${failed} 张原消息图片加载失败。已停止编辑重发，对话未回退；请重试加载。`)
  }
  return images
}
