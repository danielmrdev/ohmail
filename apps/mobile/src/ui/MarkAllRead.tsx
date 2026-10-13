/**
 * The list header's "mark all read" — the webapp component's rule in this idiom
 * (`apps/webapp/app/components/MarkAllRead.tsx`): it renders NOTHING when the view shows
 * nothing to clear, because a control pressable against an already-cleared list lies about
 * what it does. Two counts feed it — `unreadCount` is the mailbox's own read state, the same
 * field the rows render; `freshCount` is a stream's waterline "new since you were here",
 * which can stand above zero unread — and the spoken name carries whichever the press is
 * about. The press itself is the caller's (`actions.markAllSeen`).
 */
import { Copy } from "../copy";
import { useTheme } from "../theme";
import { Tap, Txt } from "./base";

/**
 * The row a view's head lays its title and this control in: it wraps, so at AX5 "Mark all read"
 * took its own line instead of running 58pt off the screen.
 */
export const VIEW_HEAD_ROW = { flexDirection: "row", alignItems: "center", flexWrap: "wrap", columnGap: 10 } as const;

export function MarkAllRead({
  unreadCount,
  freshCount = 0,
  onPress,
}: {
  unreadCount: number;
  /** The fresh side of the view's waterline, for the streams. Absent ⇒ unread alone decides. */
  freshCount?: number;
  onPress: () => void;
}) {
  const t = useTheme();
  if (unreadCount <= 0 && freshCount <= 0) return null;
  return (
    <Tap
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={
        unreadCount > 0 ? Copy.markAllAria(unreadCount) : Copy.markAllAriaFresh(freshCount)
      }
      style={({ pressed }) => ({
        /* THE HEAD WRAPS AROUND IT (`VIEW_HEAD_ROW`): it keeps to the trailing edge, on the title's
           line while both fit and on its own line at the largest text sizes, never past the edge. */
        marginLeft: "auto",
        flexShrink: 1,
        maxWidth: "100%",
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: t.radius.pill,
        backgroundColor: pressed ? t.c.tint : "transparent",
      })}
    >
      <Txt variant="caption" tone="ink3">
        {Copy.markAll}
      </Txt>
    </Tap>
  );
}
