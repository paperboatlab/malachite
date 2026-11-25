// A chip that opens a menu below it: the Views bar's filters, the view picker, a property's value.
import { Menu, type MenuEntry } from "@paperboatlab/ui";
import { useRef, useState, type ReactNode } from "react";

export function MenuChip({ label, menu, className = "chip", children }: { label: string; menu: MenuEntry[]; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <span className="chipw">
      <button ref={ref} type="button" className={className} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{children}</button>
      {open && <Menu label={label} items={menu} triggerRef={ref} onClose={() => setOpen(false)} />}
    </span>
  );
}
