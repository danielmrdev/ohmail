/**
 * THE ADMIT ARM for `mail-list-census.test.ts` — the shape every list screen now has: the rows
 * handed to `MailList`, the row drawn inside its `renderRow`. A census that refused this would
 * refuse the app; a census that admits the sibling file has no rule at all.
 */
import { MailList } from "../../../src/ui/MailList";
import { MailRow } from "../../../src/ui/MailRow";

export function Admitted({ rows, open }: { rows: { id: string }[]; open: (id: string) => void }) {
  return (
    <MailList
      groups={[{ key: "rows", rows }]}
      rowKey={(m) => m.id}
      renderRow={(m) => <MailRow m={m as never} onPress={() => open(m.id)} />}
    />
  );
}
