-- video-compare: production export for the tool (one row per completed renderforest-pro video)
-- Run it as ONE statement: in DBeaver put the cursor anywhere inside the query and press Ctrl/Cmd+Enter
-- (or select everything and press Ctrl/Cmd+Enter). Do not use "Execute script" on a partial selection.
-- Date window: edit the two timestamps in `base` below.
-- Set the window so every scenario cell you care about has rows (check with coverage.sql first).

-- After it runs, export the RESULT GRID to CSV:
--   DBeaver: right-click the result grid → Export data → CSV → keep the header, UTF-8, comma delimiter, quote strings → Next … → Proceed.
--            (DBeaver exports all rows of the query, not only the fetched page.)
--   psql:    \copy ( <this query without the trailing semicolon> ) TO 'minimax-prod.csv' WITH (FORMAT csv, HEADER true)
-- Then upload the CSV in the tool ("Upload production CSV → new run").

WITH base AS (
  SELECT
    avp.id,
    avp."createdAt",
    avp."userId",
    avp."videoModel",
    avp.quality,
    avp."aspectRatio",
    avp."videoDurationSeconds",
    avp.prompt,
    avp."videoUrl",
    avp.width,
    avp.height,
    avp.source                                                   AS flow,
    (avp.meta::jsonb ->> 'videoSource')                          AS meta_flow,
    NULLIF(avp.meta::jsonb ->> 'imageStyleId', '')::int          AS meta_style_id,
    NULLIF(avp.meta::jsonb ->> 'sourceProjectId', '')::int       AS source_project_id,
    avp."referenceMedias"::jsonb                                 AS rm
  FROM ai_video_projects avp
  WHERE avp."videoSource" = 'renderforest'
    AND avp."videoModel" <> 'forest-1.0'
    AND avp."videoModel" <> 'renderforest-avatar'
    AND avp.status = 'completed'
    AND avp."videoUrl" IS NOT NULL
    AND avp."createdAt" >= '2026-08-25'::timestamp  -- <<< change the window here
    AND avp."createdAt" <  '2026-09-26'::timestamp  -- <<< and here
),
media AS (
  SELECT
    b.*,
    (SELECT i ->> 'url' FROM jsonb_array_elements(COALESCE(b.rm -> 'images', '[]'::jsonb)) i
       WHERE i ->> 'type' = 'firstFrame' LIMIT 1)                                        AS first_frame_url,
    (SELECT i ->> 'url' FROM jsonb_array_elements(COALESCE(b.rm -> 'images', '[]'::jsonb)) i
       WHERE i ->> 'type' = 'lastFrame' LIMIT 1)                                         AS last_frame_url,
    (SELECT a ->> 'url' FROM jsonb_array_elements(COALESCE(b.rm -> 'audios', '[]'::jsonb)) a
       WHERE a ->> 'type' = 'voiceOver' LIMIT 1)                                         AS voice_over_url,
    (SELECT COALESCE((a ->> 'audioStartTime')::numeric, 0)
       FROM jsonb_array_elements(COALESCE(b.rm -> 'audios', '[]'::jsonb)) a
       WHERE a ->> 'type' = 'voiceOver' LIMIT 1)                                         AS audio_start_time,
    (SELECT string_agg(i ->> 'url', '|' ORDER BY ord)
       FROM jsonb_array_elements(COALESCE(b.rm -> 'images', '[]'::jsonb)) WITH ORDINALITY AS t(i, ord)
       WHERE i ->> 'type' = 'referenceImage')                                            AS reference_images,
    (SELECT string_agg(a ->> 'url', '|' ORDER BY ord)
       FROM jsonb_array_elements(COALESCE(b.rm -> 'audios', '[]'::jsonb)) WITH ORDINALITY AS t(a, ord)
       WHERE a ->> 'type' = 'referenceAudio')                                            AS reference_audios,
    (SELECT count(*) FROM jsonb_array_elements(COALESCE(b.rm -> 'videos', '[]'::jsonb)))  AS reference_video_count
  FROM base b
),
styled AS (
  SELECT
    m.*,
    gap."videoType"                                              AS video_type_code,
    COALESCE(m.meta_style_id, gap."styleId")                     AS style_id
  FROM media m
  LEFT JOIN LATERAL (
    SELECT g."styleId", g."videoType"
    FROM gen_ai_projects g
    WHERE g."projectId" = m.source_project_id
    ORDER BY g.id DESC
    LIMIT 1
  ) gap ON TRUE
),
final AS (
  SELECT
    s.id,
    s."createdAt"                                                AS "createdAt",
    s."userId"                                                   AS "userId",
    s."videoModel"                                               AS "videoModel",
    s.quality,
    s."aspectRatio"                                              AS "aspectRatio",
    s."videoDurationSeconds"                                     AS "videoDurationSeconds",
    s.prompt,
    s.first_frame_url                                            AS "firstFrameUrl",
    s.last_frame_url                                             AS "lastFrameUrl",
    s.voice_over_url                                             AS "voiceOverUrl",
    s.audio_start_time                                           AS "audioStartTime",
    s.reference_images                                           AS "referenceImages",
    s.reference_audios                                           AS "referenceAudios",
    s.style_id                                                   AS "styleId",
    st.name                                                      AS "styleName",
    s.video_type_code                                            AS "videoType",
    vt.name                                                      AS "videoTypeName",
    COALESCE(s.meta_flow, s.flow)                                AS flow,
    s.width,
    s.height,
    s."videoUrl"                                                 AS "videoUrl",
    -- mode exactly as ai-workers-service picks the workflow (getWorkflowConfig)
    CASE
      WHEN s.reference_images IS NOT NULL OR s.reference_audios IS NOT NULL THEN 'refi2v'
      WHEN s.voice_over_url IS NOT NULL                                     THEN 'ia2v'
      WHEN s.last_frame_url IS NOT NULL                                     THEN 'flf'
      WHEN s.first_frame_url IS NOT NULL                                    THEN 'i2v'
      ELSE 't2v'
    END                                                          AS mode,
    CASE
      WHEN s."videoDurationSeconds" <= 3  THEN '1-3'
      WHEN s."videoDurationSeconds" <= 6  THEN '4-6'
      WHEN s."videoDurationSeconds" <= 10 THEN '7-10'
      ELSE '11-15'
    END                                                          AS "durationBucket"
  FROM styled s
  LEFT JOIN ai_image_styles st ON st.id = s.style_id
  LEFT JOIN video_types     vt ON vt.code = s.video_type_code
  WHERE s.reference_video_count = 0            -- reference videos are dropped by the worker; not replayable
    AND s.quality IN (480, 720)                -- the only qualities enabled for renderforest-pro
)
SELECT
  id, "createdAt", "userId", "videoModel", quality, "aspectRatio", "videoDurationSeconds", prompt,
  "firstFrameUrl", "lastFrameUrl", "voiceOverUrl", "audioStartTime", "referenceImages", "referenceAudios",
  "styleId", "styleName", "videoType", "videoTypeName", flow, width, height, "videoUrl", mode, "durationBucket"
FROM final
ORDER BY id;
