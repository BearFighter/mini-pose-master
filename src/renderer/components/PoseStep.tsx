// SPDX-License-Identifier: GPL-3.0-or-later
// Pose step (right panel): the pose source, undo/redo, the selected bone (rotate / move hand,
// reset), the canonical bone tree, and pose-wide edits (clear, mirror, copy L->R / R->L).
import { useMemo } from 'react'
import { canonicalTree } from '../lib/pose'
import { supportArmNote } from '../lib/weapons'
import { useStore } from '../store'
import {
  clearEdits,
  clearSource,
  copySide,
  redoPose,
  resetBone,
  togglePoseMirror,
  undoPose
} from '../store/poseActions'
import { usePoseResult } from '../viewer/Viewer'
import { IconClose, IconMirror, IconRedo, IconRig, IconTrash, IconUndo } from './icons'
import { Section, StepHeader, EmptyState } from './common'

function BoneTree() {
  const rig = useStore((s) => s.rigJson)
  const selected = useStore((s) => s.boneSelection)
  const selectBone = useStore((s) => s.selectBone)
  const edits = useStore((s) => s.poseInputs.edits)
  const tree = useMemo(() => (rig ? canonicalTree(rig) : []), [rig])
  const edited = useMemo(() => new Set(edits.flatMap((op) => (op.kind === 'rotate' ? [op.bone] : [`hand.${op.side}`]))), [edits])
  return (
    <ul className="bone-tree">
      {tree.map(({ name, depth }) => (
        <li key={name}>
          <button
            className={name === selected ? 'bone-row selected' : 'bone-row'}
            style={{ paddingLeft: 8 + depth * 12 }}
            onClick={() => selectBone(name === selected ? null : name)}
          >
            {name}
            {edited.has(name) && <span className="badge">edited</span>}
          </button>
        </li>
      ))}
    </ul>
  )
}

function SelectedBone() {
  const bone = useStore((s) => s.boneSelection)
  const tool = useStore((s) => s.poseTool)
  const setTool = useStore((s) => s.setPoseTool)
  const boneOnly = useStore((s) => s.boneOnly)
  const setBoneOnly = useStore((s) => s.setBoneOnly)
  const pose = usePoseResult()
  const weapons = useStore((s) => s.weapons)
  if (!bone) return <p className="muted small">Click the model, a joint dot or a bone in the list to select it.</p>
  const hand = /^hand\.([LR])$/.exec(bone)?.[1] as 'L' | 'R' | undefined
  const short = hand ? pose?.reachShort[hand] : undefined
  const held = supportArmNote(bone, weapons)
  return (
    <>
      <p className="selected-bone">
        <span className="bone-swatch" aria-hidden="true" />
        <strong>{bone}</strong>
      </p>
      {hand && (
        <div className="tabs segmented small-tabs" role="tablist">
          <button className={tool === 'rotate' ? 'tab active' : 'tab'} onClick={() => setTool('rotate')}>
            Rotate
          </button>
          <button className={tool === 'reach' ? 'tab active' : 'tab'} onClick={() => setTool('reach')}>
            Move hand
          </button>
        </div>
      )}
      {(!hand || tool === 'rotate') && (
        <label className="toggle-line" title="Otherwise the bones below it follow (hold Alt while dragging for one drag)">
          <input type="checkbox" checked={boneOnly} onChange={(e) => setBoneOnly(e.target.checked)} /> Rotate bone only
        </label>
      )}
      {short !== undefined && short > 0.001 && <p className="warn small">Can't reach by {(short * 1000).toFixed(0)} mm</p>}
      {held && <p className="hint small tip">{held}</p>}
      <div className="button-row">
        <button onClick={() => resetBone(bone)}>Reset bone</button>
      </div>
    </>
  )
}

export function PoseStep() {
  const rig = useStore((s) => s.rigJson)
  const inputs = useStore((s) => s.poseInputs)
  const notice = useStore((s) => s.poseNotice)
  const setNotice = useStore((s) => s.setPoseNotice)
  const canUndo = useStore((s) => s.undo.length > 0)
  const canRedo = useStore((s) => s.redo.length > 0)
  const clip = useStore((s) => s.loadedClip)
  const pose = usePoseResult()

  if (!rig) {
    return (
      <div className="step-panel">
        <StepHeader step="pose" />
        <EmptyState icon={<IconRig size={22} />} title="Build the rig first">
          <p>The Rig step places the joints and builds the rig this step needs.</p>
        </EmptyState>
      </div>
    )
  }
  const sourceTitle = inputs.source ? (clip?.entry.move ? `${clip.entry.move}${clip.entry.style ? ` · ${clip.entry.style}` : ''}` : inputs.source.clip) : null

  return (
    <div className="step-panel">
      <StepHeader step="pose">
        <button className="icon-button" onClick={undoPose} disabled={!canUndo} title="Undo (Ctrl+Z)" aria-label="Undo">
          <IconUndo size={16} />
        </button>
        <button className="icon-button" onClick={redoPose} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)" aria-label="Redo">
          <IconRedo size={16} />
        </button>
      </StepHeader>
      {notice && (
        <p className="notice">
          {notice}{' '}
          <button className="icon" onClick={() => setNotice(null)} title="Dismiss" aria-label="Dismiss">
            <IconClose size={14} />
          </button>
        </p>
      )}
      <Section title="Source">
        {inputs.source ? (
          <p>
            {sourceTitle} <span className="muted small">({inputs.source.pack}, frame {inputs.source.frame})</span>
          </p>
        ) : (
          <p className="muted small">Rest pose. Pick a clip in the library on the left.</p>
        )}
        <div className="button-row">
          <button onClick={togglePoseMirror} className={inputs.mirrored ? 'on' : ''}>
            <IconMirror size={14} />
            {inputs.mirrored ? 'Mirrored' : 'Mirror pose'}
          </button>
          {inputs.source && <button onClick={clearSource}>Rest pose</button>}
        </div>
      </Section>
      <Section title="Bone">
        <SelectedBone />
      </Section>
      <Section title={`Edits (${inputs.edits.length})`}>
        <div className="button-row">
          <button onClick={() => copySide('L')} title="Copy the left side's pose to the right side">
            Copy pose L→R
          </button>
          <button onClick={() => copySide('R')} title="Copy the right side's pose to the left side">
            Copy pose R→L
          </button>
          <button className="danger" onClick={clearEdits} disabled={inputs.edits.length === 0}>
            <IconTrash size={14} />
            Clear edits
          </button>
        </div>
        {pose && pose.skipped.length > 0 && <p className="warn small">{pose.skipped.length} edits don't apply to this rig.</p>}
      </Section>
      <Section title="Bones">
        <BoneTree />
      </Section>
    </div>
  )
}
