# KAX stored-card terms, version v1

This is the document a KAX account accepts before it may keep a card on file.
The server serves these exact words and records the SHA-256 of them alongside
every acceptance, so what an account agreed to stays answerable even after the
terms are rewritten. Editing a single character here changes that hash, and a
changed hash is a different agreement — so this file is superseded by a new
version rather than amended in place.

## 1. What we keep

We do not keep your card. The number, the expiry date and the security code go
straight to Stripe, our payment processor, and never reach a KAX server. What
we keep afterwards is what Stripe tells us about the card: its brand, its last
four digits, its printed expiry month and year, and an identifier that lets us
ask Stripe to charge it again.

## 2. What we charge

We charge your card only for a purchase you place. Before you confirm one, we
show you the item price, the shipping cost and the total in US dollars, and the
total shown is the amount charged. There is no subscription, no recurring
charge, and no balance held on your account.

## 3. Charging while you are away

Saving a card marks it at Stripe for use when you are not at the keyboard. In
practice that means an order you place can be charged without you typing the
card in again, and that your bank may still occasionally ask you to confirm a
payment before it goes through.

## 4. Where we ship

We ship to the United States only. The address you save is used to make and
deliver your order, and a copy of it is kept with that order — what was sent,
and where, has to remain answerable long after you have changed where you live.

## 5. Removing your card

You may remove a saved card at any time from your purchasing settings, and we
ask Stripe to detach it immediately. Orders already placed are unaffected: the
record of a charge that has already happened is the evidence behind any refund
or dispute, so it stays.

## 6. Refunds

An order cancelled before it is released for production is refunded in full.
After production has begun, a refund is at our discretion — except that an item
which arrives damaged or misprinted is always replaced or refunded.

## 7. Changes to these terms

We may publish a later version of this document. A later version does not bind
you until you have accepted it, and until you do we will ask before charging
your saved card again.
