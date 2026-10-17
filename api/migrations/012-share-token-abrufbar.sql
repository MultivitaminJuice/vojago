-- Migration 012 — Freigabe-Link erneut abrufbar (Klartext-Token ergänzt)
--
-- Bewusst im Klartext, anders als bei sessions/password_resets: der Besitzer
-- muss einen einmal erstellten Link jederzeit wieder herausgeben können, um
-- ihn erneut zu verschicken — ohne ihn zu widerrufen und neu anzulegen.
ALTER TABLE trip_shares ADD COLUMN token TEXT;
