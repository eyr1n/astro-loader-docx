-- Drop size attributes so images stay plain Markdown that Astro can optimize
function Image(el)
  el.attributes = {}
  return el
end
