import { formatDateTime } from '@/lib/format';
import type { ThreadMessage } from '@/lib/clubs/inbox';
import { cn } from '@/lib/utils';

/**
 * One conversation, oldest first (0052). The viewer's own side sits on the
 * right. Text is shown as written — whitespace kept, never parsed as markup.
 * On the member's side the club's messages carry the club's name only.
 */
export function ThreadMessages({
  messages,
  viewer,
  locale,
  labels,
}: {
  messages: ThreadMessage[];
  viewer: 'club' | 'member';
  locale: string;
  labels: { member: string; club: string; formerStaff: string };
}) {
  return (
    <ol className="space-y-3">
      {messages.map((message) => {
        const own = message.author === viewer;
        const who =
          message.author === 'member'
            ? labels.member
            : viewer === 'club'
              ? (message.staffName ?? labels.formerStaff)
              : labels.club;
        return (
          <li key={message.id} className={cn('flex', own ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] space-y-1 rounded-card border p-3',
                own ? 'border-line-strong bg-surface' : 'border-line bg-surface-2',
              )}
            >
              <p className="text-caption font-semibold text-ink-soft">
                {who}
                {' · '}
                <time dateTime={message.createdAt}>
                  {formatDateTime(message.createdAt, locale)}
                </time>
              </p>
              <p className="whitespace-pre-wrap break-words text-body-sm text-ink">
                {message.body}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
