-- The weather and tides feed is gone from the Worker (weather warnings stay, in feeds 'alerts').
DELETE FROM feeds WHERE name = 'weather';
