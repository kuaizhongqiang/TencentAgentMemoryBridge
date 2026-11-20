import type { AtomicItem } from './client.js'

const DONE_STATUS = new Set(['done', 'completed', 'cancelled', 'canceled', 'closed'])

const cap = (text: unknown, max: number): string => {
  const value = String(text ?? '')
  return value.length > max ? `${value.slice(0, max)}…[截断 ${value.length - max} 字符]` : value
}

export function parseMetadata(json: unknown): Record<string, unknown> {
  if (!json) return {}
  if (typeof json === 'object') return json as Record<string, unknown>
  try {
    const parsed = JSON.parse(String(json)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface OpenTask {
  id: string
  content: string
  priority?: number
  deadline?: string
  status?: string
  meta: Record<string, unknown>
}

/** 未结 work_task：metadata_json.status 不在 done 集合，按 deadline 升序、priority 降序。 */
export function openWorkTasks(items: AtomicItem[] = []): OpenTask[] {
  return items
    .filter((item) => item && item.type === 'work_task')
    .map((item) => ({
      id: item.id,
      content: item.content,
      priority: item.priority,
      status: typeof parseMetadata(item.metadata_json).status === 'string'
        ? String(parseMetadata(item.metadata_json).status)
        : undefined,
      deadline: typeof parseMetadata(item.metadata_json).deadline === 'string'
        ? String(parseMetadata(item.metadata_json).deadline)
        : undefined,
      meta: parseMetadata(item.metadata_json),
    }))
    .filter((item) => !DONE_STATUS.has(String(item.meta.status ?? '').toLowerCase()))
    .sort((a, b) => {
      const da = Date.parse(String(a.meta.deadline ?? '')) || Number.POSITIVE_INFINITY
      const db = Date.parse(String(b.meta.deadline ?? '')) || Number.POSITIVE_INFINITY
      if (da !== db) return da - db
      return (Number(b.priority) || 0) - (Number(a.priority) || 0)
    })
}

/** L2 场景只保留索引，丢掉 summary（summary 是召回 token 炸弹）。 */
export function trimScenes(entries: Array<{ path: string; summary?: string; updated_at?: string }> = []): Array<{
  path: string
  updated_at?: string
  has_summary?: boolean
}> {
  return entries.slice(0, 20).map((entry) => ({
    path: entry.path,
    updated_at: entry.updated_at,
    ...(entry.summary ? { has_summary: true } : {}),
  }))
}

/** L3 画像摘要：thesis + 标题 + 每个标题下第一条要点，跳过 Scene Navigation。 */
export function digestPersona(text: string, maxChars = 1200): string {
  const lines = String(text || '').split('\n')
  const picked: string[] = []
  let sinceHeading = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (/^#{1,3}\s.*Scene Navigation/i.test(line)) break
    if (/^###\s+Path:/.test(line)) continue
    if (/^\*\*热度\*\*/.test(line)) continue
    if (/^>\s*\*\*Operating Thesis\*\*/.test(line)) {
      picked.push(line)
      continue
    }
    if (/^#{1,3}\s/.test(line)) {
      picked.push(line)
      sinceHeading = 0
      continue
    }
    if (sinceHeading === 0 && /^[-*]\s/.test(line)) {
      picked.push(line)
      sinceHeading += 1
    }
    if (picked.join('\n').length >= maxChars) break
  }
  return cap(picked.join('\n'), maxChars)
}

export interface BriefInput {
  binding?: { task_id: string; title?: string; bound_at?: string } | null
  persona?: { content?: string } | null
  scenes?: { entries?: Array<{ path: string; summary?: string; updated_at?: string }> } | null
  tasks?: { items?: AtomicItem[] } | null
  facts?: { items?: AtomicItem[] } | null
}

export interface Brief {
  task: { task_id: string; title?: string; bound_at?: string } | null
  persona_digest: string
  open_tasks: Array<{ id: string; content: string; deadline?: string; priority?: number; status?: string }>
  scenes: Array<{ path: string; updated_at?: string; has_summary?: boolean }>
  recent_facts: Array<{ id: string; type?: string; content: string; updated_at?: string }>
  _size_chars: number
  _budget_chars: number
}

/** 预算化简报：场景→事实→任务→画像 依次裁剪（任务与画像优先保留）。 */
export function composeBrief(input: BriefInput, opts: { maxChars?: number } = {}): Brief {
  const budget = Number(opts.maxChars) || 8000
  const tasks = openWorkTasks(input.tasks?.items ?? []).slice(0, 8)
  const facts = (input.facts?.items ?? []).filter((item) => item && item.type !== 'work_task').slice(0, 8)

  const brief: Brief = {
    task: input.binding
      ? { task_id: input.binding.task_id, title: input.binding.title, bound_at: input.binding.bound_at }
      : null,
    persona_digest: digestPersona(input.persona?.content ?? '', 1400),
    open_tasks: tasks.map((task) => ({
      id: task.id,
      content: cap(task.content, 300),
      ...(task.deadline ? { deadline: task.deadline } : {}),
      ...(task.priority !== undefined ? { priority: task.priority } : {}),
      ...(task.status ? { status: task.status } : {}),
    })),
    scenes: trimScenes(input.scenes?.entries ?? []),
    recent_facts: facts.map((fact) => ({
      id: fact.id,
      type: fact.type,
      content: cap(fact.content, 200),
      ...(fact.updated_at ? { updated_at: fact.updated_at } : {}),
    })),
    _size_chars: 0,
    _budget_chars: budget,
  }

  const sizeOf = () => JSON.stringify(brief).length
  while (sizeOf() > budget && brief.scenes.length > 0) brief.scenes.pop()
  while (sizeOf() > budget && brief.recent_facts.length > 0) brief.recent_facts.pop()
  while (sizeOf() > budget && brief.open_tasks.length > 0) brief.open_tasks.pop()
  brief._size_chars = sizeOf()
  return brief
}
