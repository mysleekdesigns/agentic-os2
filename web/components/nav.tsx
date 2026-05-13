import Link from 'next/link';

const links = [
  { href: '/runs', label: 'Runs' },
  { href: '/approvals', label: 'Approvals' },
  { href: '/memory', label: 'Memory' },
  { href: '/evals', label: 'Evals' },
];

export function Nav() {
  return (
    <header className="border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
      <div className="mx-auto flex max-w-6xl items-center justify-between p-4">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          agent-os dashboard
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            >
              {l.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
