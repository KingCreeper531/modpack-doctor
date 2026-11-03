/** #work-order: review, live execution, the Enter-able single-rename undo, and a finished undo with a failure. */
import { useEffect, useRef, useState } from 'react';

import type { OpStatus } from '../../bindings';
import { WorkOrderPanel, type WorkOrderPhase } from '../components/WorkOrderPanel';
import { STATUSES_FINISHED, STATUSES_RUNNING, WORK_ORDER_FIX, WORK_ORDER_RESTORE, WORK_ORDER_UNDO } from './fixtures';
import { Section, Spec, SpecRow } from './Section';

const STEP_MS = 700;

/** Click Execute to watch the statuses advance like `OpStatus` events. */
function LiveFixOrder() {
  const [phase, setPhase] = useState<WorkOrderPhase>('review');
  const [statuses, setStatuses] = useState<OpStatus[]>([]);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const execute = () => {
    setPhase('running');
    let i = 0;
    const ops = WORK_ORDER_FIX.ops.length;
    const tick = () => {
      setStatuses(
        Array.from({ length: Math.min(ops, i + 1) }, (_, k): OpStatus => ({
          orderId: WORK_ORDER_FIX.id,
          index: k,
          state: k < i ? 'done' : 'running',
          message: null,
        })),
      );
      if (i >= ops) {
        window.clearInterval(timer.current);
        setStatuses(WORK_ORDER_FIX.ops.map((_, k) => ({ orderId: WORK_ORDER_FIX.id, index: k, state: 'done', message: null })));
        setPhase('finished');
      }
      i++;
    };
    tick();
    timer.current = window.setInterval(tick, STEP_MS);
  };

  return (
    <WorkOrderPanel
      order={WORK_ORDER_FIX}
      statuses={statuses}
      phase={phase}
      onExecute={execute}
      onCancel={() => {
        window.clearInterval(timer.current);
        setStatuses([]);
        setPhase('review');
      }}
    />
  );
}

export function WorkOrderSection() {
  const [undoDone, setUndoDone] = useState(false);
  return (
    <Section id="work-order" title="Work order" spec="§6.4" meta="replaces the workspace bottom section · never a modal">
      <SpecRow className="flex-col">
        <Spec label="Review → execute" note="click Execute; Esc cancels; Enter does nothing here" className="w-full">
          <div className="border border-line">
            <LiveFixOrder />
          </div>
        </Spec>
        <Spec label="Running" note="6px sweep bar; static under reduced motion" className="w-full">
          <div className="border border-line">
            <WorkOrderPanel order={WORK_ORDER_FIX} statuses={STATUSES_RUNNING} phase="running" onExecute={() => undefined} onCancel={() => undefined} />
          </div>
        </Spec>
        <Spec label="Undo, single rename" note="the only order Enter may execute: ↵ hint" className="w-full">
          <div className="border border-line">
            <WorkOrderPanel
              order={WORK_ORDER_UNDO}
              statuses={undoDone ? [{ orderId: WORK_ORDER_UNDO.id, index: 0, state: 'done', message: null }] : []}
              phase={undoDone ? 'finished' : 'review'}
              onExecute={() => setUndoDone(true)}
              onCancel={() => setUndoDone(false)}
            />
          </div>
        </Spec>
        <Spec label="Finished with a failure" note="done · failed (message inline) · skipped" className="w-full">
          <div className="border border-line">
            <WorkOrderPanel order={WORK_ORDER_RESTORE} statuses={STATUSES_FINISHED} phase="finished" rolledBack onExecute={() => undefined} onCancel={() => undefined} />
          </div>
        </Spec>
      </SpecRow>
    </Section>
  );
}
