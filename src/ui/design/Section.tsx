/** Sheet scaffolding: ruled sections with an anchor id and labelled specimens. */
import type { ReactNode } from 'react';

import { cx } from '../components/cx';

export function Section({ id, title, spec, meta, children }: { id: string; title: string; spec: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="scroll-mt-8 border-b border-line-strong">
      <header className="flex h-8 items-center gap-4 border-b border-line bg-panel px-4">
        <span className="w-12 t-mono text-fg-faint">{spec}</span>
        <h2 id={`${id}-h`} className="t-label text-fg">
          {title}
        </h2>
        <span className="ml-auto t-mono text-fg-faint">{meta}</span>
      </header>
      {children}
    </section>
  );
}

/** One labelled specimen: a 24px caption row over the component. */
export function Spec({ label, note, className, children }: { label: string; note?: string; className?: string; children: ReactNode }) {
  return (
    <div className={cx('flex min-w-0 flex-col', className)}>
      <div className="flex h-6 items-center gap-2">
        <span className="t-label text-fg-faint">{label}</span>
        {note ? <span className="truncate t-mono text-fg-faint">{note}</span> : null}
      </div>
      {children}
    </div>
  );
}

/** A row of specimens separated by hairlines, the way a parts catalogue lays out a page. */
export function SpecRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('flex flex-wrap items-start gap-x-8 gap-y-4 border-b border-line px-4 py-4 last:border-b-0', className)}>{children}</div>;
}
