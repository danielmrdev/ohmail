/**
 * THE POSITIVE CONTROL for `mail-list-census.test.ts` — the shape the census exists to refuse:
 * every row mounted through `rows.map` inside a `Scroller`, no `MailList` anywhere. Not part of
 * the app (`tsconfig.json` excludes `test/fixtures`). The census must name all three refusals
 * here, or it has certified the app's lists as windowed without being able to see a list.
 */
import { Scroller } from "../../../src/ui/base";
import { MailRow } from "../../../src/ui/MailRow";

export function Planted({ rows, open }: { rows: { id: string }[]; open: (id: string) => void }) {
  return (
    <Scroller>
      {rows.map((m) => (
        <MailRow key={m.id} m={m as never} onPress={() => open(m.id)} />
      ))}
    </Scroller>
  );
}
