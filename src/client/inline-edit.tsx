/**
 * InlineEdit — the in-place "edit a sent user message" editor.
 *
 * It is mounted as a DOM sibling right after the hidden original user row,
 * so visually it occupies the same slot as the message being edited. It
 * mirrors the composer's key affordances: an auto-growing plain textarea, a
 * model selector plus a reasoning-effort selector backed by the shared
 * ui-model-selection directory, and the same circular send button treatment.
 * Submitting is a three-step host dance:
 * recall the original instruction (server appends a replacement surface),
 * select the chosen model through the shared directory, then push the edited
 * text through the ordinary composer submit path.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type {
  ModelDirectoryFace, ModelDirectoryState, ModelInfo, ModelSelection,
} from './context-types.ts'
import css from './inline-edit.module.css'

const EMPTY_STATE: ModelDirectoryState = {
  current: null,
  groups: [],
  status: 'idle',
  error: null,
}

export interface InlineEditProps {
  readonly sessionId: string
  readonly initialText: string
  readonly modelDirectory: ModelDirectoryFace | null
  /** Deliver the edited text; resolves when sent, rejects with a user-facing message. */
  readonly onSubmit: (text: string, selection: ModelSelection | null) => Promise<void>
  readonly onCancel: () => void
}

/** Same provider/model row id convention as ui-model-selection. */
function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

function selectionOf(
  current: ModelSelection | null,
  groupId: string,
  model: ModelInfo,
): ModelSelection {
  const sameRoute = current?.provider === groupId && current.model === model.id
  const reasoningEffort = sameRoute
    ? current?.reasoningEffort ?? model.reasoning?.defaultEffort
    : model.reasoning?.defaultEffort
  return {
    provider: groupId,
    model: model.id,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

const SEND_SVG = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor"/></svg>`

export function InlineEdit({ sessionId, initialText, modelDirectory, onSubmit, onCancel }: InlineEditProps) {
  const [draft, setDraft] = useState(initialText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<ModelSelection | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const mounted = useRef(true)

  const subscribe = useCallback((onStoreChange: () => void): (() => void) => {
    if (modelDirectory === null) return () => {}
    return modelDirectory.store.subscribe(onStoreChange)
  }, [modelDirectory])
  const getSnapshot = useCallback((): ModelDirectoryState => (
    modelDirectory === null ? EMPTY_STATE : modelDirectory.store.getSnapshot()
  ), [modelDirectory])
  const directoryState = useSyncExternalStore(subscribe, getSnapshot)

  // Mount-time load resolves the trigger label / current selection; the
  // composer model seat does the same on mount.
  useEffect(() => {
    if (modelDirectory !== null) {
      void modelDirectory.load().catch(() => { /* errors land on the shared store */ })
    }
  }, [modelDirectory])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  // Default the inline selector to the composer's current model once the
  // directory reports one; a manual pick overwrites this and is sticky.
  useEffect(() => {
    if (selection === null && directoryState.current !== null) {
      setSelection(directoryState.current)
    }
  }, [selection, directoryState.current])

  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.focus()
    const end = textarea.value.length
    textarea.setSelectionRange(end, end)
  }, [])

  // Auto-grow the textarea up to a sane cap.
  useEffect(() => {
    const textarea = textareaRef.current
    if (textarea === null) return
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`
  }, [draft])

  const providerOptions = useMemo(() => directoryState.groups.map(group => ({
    group,
    models: group.models.map(model => ({
      id: rowId(group.id, model.id),
      modelName: model.name,
      selection: selectionOf(directoryState.current, group.id, model),
      reasoning: model.reasoning,
    })),
  })), [directoryState.groups, directoryState.current])

  const selectedId = selection === null
    ? directoryState.current === null ? '' : rowId(directoryState.current.provider, directoryState.current.model)
    : rowId(selection.provider, selection.model)

  const selectedIdMissing = selectedId !== '' && !providerOptions.some(provider =>
    provider.models.some(model => model.id === selectedId))

  /** The selected model's reasoning config, when it is listed in the directory. */
  const selectedReasoning = useMemo(() => {
    for (const provider of providerOptions) {
      const match = provider.models.find(item => item.id === selectedId)
      if (match !== undefined) return match.reasoning
    }
    return undefined
  }, [providerOptions, selectedId])
  const effortChoices = selectedReasoning?.efforts ?? []

  /** The effort that would be sent right now ('' = model default). */
  const currentEffort = (selection === null
    ? directoryState.current?.reasoningEffort
    : selection.reasoningEffort) ?? ''

  const changeModel = (value: string): void => {
    for (const provider of providerOptions) {
      const option = provider.models.find(item => item.id === value)
      if (option !== undefined) {
        setSelection(option.selection)
        return
      }
    }
  }

  const changeEffort = (value: string): void => {
    const route = selection ?? directoryState.current
    if (route === null) return
    setSelection({
      provider: route.provider,
      model: route.model,
      ...(value === '' ? {} : { reasoningEffort: value }),
    })
  }

  const send = async (): Promise<void> => {
    const text = draft.trim()
    if (text === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      if (modelDirectory !== null && selection !== null) {
        const current = modelDirectory.store.getSnapshot().current
        if (
          current?.provider !== selection.provider
          || current.model !== selection.model
          || current.reasoningEffort !== selection.reasoningEffort
        ) {
          await modelDirectory.select(selection)
        }
      }
      await onSubmit(text, selection)
    } catch (cause) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void send()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    <div className={css.root}>
      <div className={css.card}>
        <textarea
          ref={textareaRef}
          className={css.textarea}
          value={draft}
          rows={1}
          aria-label="编辑消息"
          placeholder="编辑后发送…"
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={onKeyDown}
        />
        {error !== null && <div className={css.error} role="status">{error}</div>}
        <div className={css.row}>
          <div className={css.left}>
            {modelDirectory !== null && (
              <select
                className={css.modelSelect}
                value={selectedId}
                disabled={busy}
                aria-label="选择模型"
                title={selectedId === '' ? '当前模型' : selectedId}
                onChange={(event) => { changeModel(event.target.value) }}
              >
                {selectedId === '' && <option value="">当前模型</option>}
                {selectedIdMissing && (
                  <option value={selectedId}>当前模型（{selectedId}）</option>
                )}
                {providerOptions.map(({ group, models }) => (
                  <optgroup key={group.id} label={group.name}>
                    {models.map(model => (
                      <option key={model.id} value={model.id}>{model.modelName}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            )}
            {modelDirectory !== null && effortChoices.length > 0 && (
              <select
                className={`${css.modelSelect} ${css.effortSelect}`}
                value={currentEffort}
                disabled={busy}
                aria-label="思考强度"
                title="思考强度"
                onChange={(event) => { changeEffort(event.target.value) }}
              >
                <option value="">默认强度</option>
                {effortChoices.map(effort => (
                  <option key={effort.id} value={effort.id}>{effort.name ?? effort.id}</option>
                ))}
              </select>
            )}
          </div>
          <div className={css.actions}>
            <button
              type="button"
              className={css.cancel}
              disabled={busy}
              onClick={onCancel}
            >
              取消
            </button>
            <button
              type="button"
              className={css.send}
              disabled={busy || draft.trim() === ''}
              aria-label="发送"
              title="发送"
              onClick={() => { void send() }}
              dangerouslySetInnerHTML={{ __html: SEND_SVG }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
