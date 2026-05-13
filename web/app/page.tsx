import Link from 'next/link';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const sections = [
  {
    href: '/runs',
    title: 'Runs',
    description: 'Inspect timelines and transcripts for recent agent and workflow runs.',
  },
  {
    href: '/approvals',
    title: 'Approvals',
    description: 'Review pending tool-use approvals and act on them.',
  },
  {
    href: '/memory',
    title: 'Memory',
    description: 'Browse memory entries by scope and search across keys.',
  },
  {
    href: '/evals',
    title: 'Evals',
    description: 'View evaluation run reports and diff fixture outcomes.',
  },
];

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">agent-os dashboard</h1>
        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
          Read-only local view over the same SQLite database used by the CLI.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <Link key={s.href} href={s.href} className="block">
            <Card className="h-full transition-colors hover:border-slate-400 dark:hover:border-slate-600">
              <CardHeader>
                <CardTitle>{s.title}</CardTitle>
                <CardDescription>{s.description}</CardDescription>
              </CardHeader>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
