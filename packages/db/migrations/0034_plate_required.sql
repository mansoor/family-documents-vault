-- The card asks for a type's details (iteration 5.10).
--
-- A vehicle registration's plate is required from here (A9), as 0032 made
-- a passport's number and expiry. 0032 held it back: the plate is one of
-- the type's own details, and until now no screen could add one, so every
-- car would have read Needs info with nothing to be done about it. From
-- this release the card asks for it, in the type's own word ("Registration
-- plate"), and marks it required.
--
-- Nothing is ever refused for want of it (A7): a car without a plate reads
-- "Needs a registration plate" until somebody adds it. That is worked out
-- whenever a document is read, from its type as it is now, so the cars
-- already in a vault say so from the day this lands; an Only me car whose
-- plate is sealed counts it as given (sealed_details, 0033).
--
-- Only the built-in changes. A household that has changed the type's own
-- fields (document_type_setting.fields) keeps its own list, as every pack
-- upgrade leaves it (A8).
--
-- A migration is nobody's edit: no document's updated_at moves, and no
-- audit event is written.

update document_type t
   set fields = (select jsonb_agg(case when e->>'key' = 'plate'
                                       then e || '{"required": true}'
                                       else e end
                                  order by i)
                   from jsonb_array_elements(t.fields) with ordinality x(e, i)),
       pack_version = t.pack_version + 1
 where t.key = 'vehicle_registration' and t.household_id is null;
