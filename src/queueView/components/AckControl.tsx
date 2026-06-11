/**
 * The ack control (design/05-ui.md): the product's core interaction gets a
 * permanent slot — "Ready for another look" when actionable, the sent chip
 * once acked. Withdraw/note affordances appear on hover.
 */

import { useState, type JSX } from 'react';

import { AckChipDisplay, CardDisplay } from '../../queue/displayTypes';
import { formatClock } from '../format';
import { ACK_CHIP_ICON } from '../icons';
import { usePost } from './QueueApp';

const CHIP_TEXT: Record<AckChipDisplay['state'], (chip: AckChipDisplay) => string> = {
	pending: (c) => `sent ${formatClock(c.createdAt)}`,
	'picked-up': () => 'picked up',
	superseded: () => 'superseded',
	'pickup-unconfirmed': () => 'sent · pickup unconfirmed',
	stale: () => 'sent — not picked up',
	'moved-on': () => 'state moved on since ack',
};

const CHIP_HOVER: Partial<Record<AckChipDisplay['state'], string>> = {
	superseded: 'the orchestrator already saw your forge activity and advanced',
	'pickup-unconfirmed': 'the file is gone but no consumption was recorded; re-ack if needed',
	stale: 'an orchestrator pass completed without consuming this ack — the loop may be down',
	'moved-on': 'the ticket advanced past the request you acked; ack again if needed',
};

export function AckControl({ card }: { card: CardDisplay }): JSX.Element {
	const post = usePost();
	const [noteOpen, setNoteOpen] = useState(false);
	const [note, setNote] = useState('');
	const { actionable, chip } = card.ackControl;

	const send = (): void => {
		post({ type: 'ack', repoRoot: card.repoRoot, ticket: card.ticket ?? '', note: note.trim() || null });
		setNoteOpen(false);
		setNote('');
	};

	if (noteOpen) {
		return (
			<span className="ack-slot" onClick={(e) => e.stopPropagation()}>
				<input
					className="ack-note-input"
					autoFocus
					placeholder="note for the agent (optional) — Enter to send"
					value={note}
					onChange={(e) => setNote(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === 'Enter') send();
						if (e.key === 'Escape') setNoteOpen(false);
					}}
				/>
				<button className="text-button primary" onClick={send}>
					Send
				</button>
			</span>
		);
	}

	return (
		<span className="ack-slot" onClick={(e) => e.stopPropagation()}>
			{chip && <Chip card={card} chip={chip} />}
			{actionable && (
				<button className="text-button primary" onClick={() => setNoteOpen(true)}>
					Ready for another look
				</button>
			)}
		</span>
	);
}

function Chip({ card, chip }: { card: CardDisplay; chip: AckChipDisplay }): JSX.Element {
	const post = usePost();
	const hover = [CHIP_HOVER[chip.state], chip.note ? `note: ${chip.note}` : null, `ack ${chip.ackId}`]
		.filter(Boolean)
		.join(' · ');
	return (
		<span className={`ack-chip ${chip.state}`} title={hover}>
			<span className={`codicon codicon-${ACK_CHIP_ICON[chip.state]}`} />
			<span>{CHIP_TEXT[chip.state](chip)}</span>
			{(chip.state === 'pending' || chip.state === 'stale') && (
				<button
					className="icon-button withdraw"
					title="Withdraw this ack"
					onClick={() =>
						post({ type: 'withdrawAck', repoRoot: card.repoRoot, ticket: card.ticket ?? '', ackId: chip.ackId })
					}
				>
					<span className="codicon codicon-close" />
				</button>
			)}
		</span>
	);
}
