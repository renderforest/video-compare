-- video-compare: production export for the MiniMax (renderforest-pro) A/B
-- Run against the main Postgres (read-only). Two queries:
--   1) coverage counts per scenario cell (run first, adjust the date range until all cells you care about are non-empty)
--   2) the CSV export the tool imports
--
-- Adjust the window here:
--   :from  e.g. '2026-08-25'   (MiniMax H3 replaced wan2.2 for renderforest-pro on 2026-08-07;
--                                voice-over support landed 2026-09-03, reference audio 2026-09-08)
--   :to    e.g. '2026-09-24'

-- ---------------------------------------------------------------------------
-- Shared base: one row per completed renderforest-pro video with a playable URL
-- ---------------------------------------------------------------------------
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
    AND avp."createdAt" >= :from::timestamp
    AND avp."createdAt" <  :to::timestamp
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

-- ---------------------------------------------------------------------------
-- 1) COVERAGE: rows per scenario cell. Run this first.
-- ---------------------------------------------------------------------------
SELECT
  mode,
  quality,
  COALESCE("aspectRatio", 'auto') AS "aspectRatio",
  "durationBucket",
  COALESCE("videoTypeName", '-')  AS "videoType",
  COALESCE("styleName", 'none')   AS style,
  count(*)                        AS rows
FROM final
GROUP BY 1, 2, 3, 4, 5, 6
ORDER BY 1, 2, 3, 4, 5, 6;

-- ---------------------------------------------------------------------------
-- 2) EXPORT: replace the SELECT above with this one and write it to CSV, e.g. in psql:
--
--   \copy ( <the whole WITH ... final AS (...) block> SELECT ... FROM final ORDER BY id ) TO 'minimax-prod.csv' WITH (FORMAT csv, HEADER true)
--
-- Column order is what the tool expects. Multi-line prompts are fine (CSV-quoted).
-- ---------------------------------------------------------------------------
-- SELECT
--   id, "createdAt", "userId", "videoModel", quality, "aspectRatio", "videoDurationSeconds", prompt,
--   "firstFrameUrl", "lastFrameUrl", "voiceOverUrl", "audioStartTime", "referenceImages", "referenceAudios",
--   "styleId", "styleName", "videoType", "videoTypeName", flow, width, height, "videoUrl", mode, "durationBucket"
-- FROM final
-- ORDER BY id;
