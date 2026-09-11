import { describe, expect, it } from 'vitest'
import { reconcile, type DbFileRow } from '../src/main/scan/scanner.js'
import type { ScannedFile } from '../src/main/db/queries.js'

const file = (path: string, size: number, mtime: number): ScannedFile => ({
  folderId: 1, path, filename: path.split('/').pop()!, ext: 'jpg', kind: 'image', size, mtime
})
const row = (id: number, path: string, size: number, mtime: number): DbFileRow => ({ id, path, size, mtime })
const seenOf = (...fs: ScannedFile[]): Map<string, ScannedFile> => new Map(fs.map((f) => [f.path, f]))

describe('reconcile', () => {
  it('没有变化时四个集合都是空的', () => {
    const db = [row(1, '/a/1.jpg', 100, 5), row(2, '/a/2.jpg', 200, 6)]
    const r = reconcile(db, seenOf(file('/a/1.jpg', 100, 5), file('/a/2.jpg', 200, 6)))
    expect(r).toEqual({ moved: [], removedIds: [], added: [], changed: [] })
  })

  it('识别新增与消失', () => {
    const db = [row(1, '/a/1.jpg', 100, 5)]
    const r = reconcile(db, seenOf(file('/a/2.jpg', 999, 9)))
    expect(r.removedIds).toEqual([1])
    expect(r.added.map((a) => a.path)).toEqual(['/a/2.jpg'])
    expect(r.moved).toEqual([])
  })

  it('同一签名唯一配对时判定为移动，不重新解码', () => {
    const db = [row(7, '/a/old.jpg', 100, 5)]
    const r = reconcile(db, seenOf(file('/b/new.jpg', 100, 5)))
    expect(r.moved).toHaveLength(1)
    expect(r.moved[0]!.id).toBe(7)
    expect(r.moved[0]!.to.path).toBe('/b/new.jpg')
    expect(r.removedIds).toEqual([])
    expect(r.added).toEqual([])
  })

  it('整个目录被改名时逐一配对', () => {
    const db = [row(1, '/old/a.jpg', 10, 1), row(2, '/old/b.jpg', 20, 2), row(3, '/old/c.jpg', 30, 3)]
    const r = reconcile(db, seenOf(file('/new/a.jpg', 10, 1), file('/new/b.jpg', 20, 2), file('/new/c.jpg', 30, 3)))
    expect(r.moved).toHaveLength(3)
    expect(r.removedIds).toEqual([])
    expect(r.added).toEqual([])
  })

  it('签名有歧义时保守处理成删除加新增，不乱配', () => {
    // 两条旧记录和两个新文件签名完全一样，无法确定谁对谁
    const db = [row(1, '/old/a.jpg', 10, 1), row(2, '/old/b.jpg', 10, 1)]
    const r = reconcile(db, seenOf(file('/new/x.jpg', 10, 1), file('/new/y.jpg', 10, 1)))
    expect(r.moved).toEqual([])
    expect(r.removedIds.sort()).toEqual([1, 2])
    expect(r.added).toHaveLength(2)
  })

  it('路径不变但内容变了算 changed，要重做元数据', () => {
    const db = [row(1, '/a/1.jpg', 100, 5)]
    const r = reconcile(db, seenOf(file('/a/1.jpg', 150, 9)))
    expect(r.changed.map((c) => c.path)).toEqual(['/a/1.jpg'])
    expect(r.added).toEqual([])
    expect(r.removedIds).toEqual([])
  })

  it('移动与新增混在一起时互不干扰', () => {
    const db = [row(1, '/old/a.jpg', 10, 1), row(2, '/gone.jpg', 77, 7)]
    const r = reconcile(db, seenOf(file('/new/a.jpg', 10, 1), file('/brand-new.jpg', 55, 5)))
    expect(r.moved.map((m) => m.id)).toEqual([1])
    expect(r.removedIds).toEqual([2])
    expect(r.added.map((a) => a.path)).toEqual(['/brand-new.jpg'])
  })
})
