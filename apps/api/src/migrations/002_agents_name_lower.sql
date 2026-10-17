DO $$
DECLARE
  dup record;
  candidate text;
  suffix text;
  n integer;
BEGIN
  FOR dup IN
    SELECT id, name
    FROM (
      SELECT
        id,
        name,
        created_at,
        row_number() OVER (
          PARTITION BY lower(name)
          ORDER BY created_at, id
        ) AS nth
      FROM agents
    ) ranked
    WHERE nth > 1
    ORDER BY created_at, id
  LOOP
    n := 2;
    LOOP
      suffix := '-' || n::text;
      candidate := left(dup.name, 64 - char_length(suffix)) || suffix;
      EXIT WHEN NOT EXISTS (
        SELECT 1
        FROM agents
        WHERE id <> dup.id
          AND lower(name) = lower(candidate)
      );
      n := n + 1;
      IF n > 10000 THEN
        RAISE EXCEPTION 'could not disambiguate agent name %', dup.name;
      END IF;
    END LOOP;
    UPDATE agents SET name = candidate WHERE id = dup.id;
  END LOOP;
END
$$;

CREATE UNIQUE INDEX agents_name_lower_idx ON agents (lower(name));
