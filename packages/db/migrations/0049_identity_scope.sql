-- Identity records, sealed (iteration 5.26): the identity scope.
--
-- A household's identity key is a scope key of its own (0004's hierarchy),
-- beside the household and adults keys: it wraps the data key of each
-- person's shared identity details (0050). A separate key means widening
-- who may read them rewraps nothing, and the whole scope can later be
-- escrowed as one unit. It has no member, as the household and adults keys
-- have none, and it is minted by the API on the first write, because the
-- database never holds the master key that wraps it.
--
-- This file holds only the new value. Postgres refuses to use an enum value
-- in the transaction that adds it, and each migration is one transaction
-- (migrate.ts): 0050 is the first that may.

alter type scope_kind add value 'identity';
