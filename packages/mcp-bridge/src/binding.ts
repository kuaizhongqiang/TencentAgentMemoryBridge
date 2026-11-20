import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface TaskBinding {
  task_id: string
  title?: string
  bound_at: string
}

/**
 * 会话级 task 绑定存储（TBP）。
 *
 * MCP stdio 桥通常一个客户端会话一个进程，因此用 config.sessionKey 作为绑定键；
 * 落盘原子写（tmp + rename），损坏时回落空表，不阻断记忆读写。
 * 文件里只有 task_id/title/bound_at，**不存任何 key**。
 */
export class TaskBindingStore {
  private data: { sessions: Record<string, TaskBinding> }

  constructor(
    private readonly path: string,
    private readonly warn: (message: string) => void = () => {},
  ) {
    this.data = this.read()
  }

  private read(): { sessions: Record<string, TaskBinding> } {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { sessions?: Record<string, TaskBinding> }
      if (!raw || typeof raw !== 'object' || !raw.sessions || typeof raw.sessions !== 'object') {
        return { sessions: {} }
      }
      return { sessions: raw.sessions }
    } catch {
      return { sessions: {} }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      renameSync(tmp, this.path)
    } catch (err) {
      this.warn(`task 绑定写入失败：${(err as Error).message}`)
    }
  }

  get(sessionKey: string): TaskBinding | undefined {
    return this.data.sessions[sessionKey]
  }

  set(sessionKey: string, binding: { task_id: string; title?: string }): TaskBinding {
    const taskId = binding.task_id.trim()
    if (!taskId) throw new Error('task_bind 需要非空 task_id')
    const next: TaskBinding = {
      task_id: taskId,
      ...(binding.title ? { title: binding.title } : {}),
      bound_at: new Date().toISOString(),
    }
    this.data.sessions[sessionKey] = next
    this.persist()
    return next
  }

  clear(sessionKey: string): boolean {
    if (!this.data.sessions[sessionKey]) return false
    delete this.data.sessions[sessionKey]
    this.persist()
    return true
  }
}
