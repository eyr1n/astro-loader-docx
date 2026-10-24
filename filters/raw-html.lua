-- Paragraphs between a "```{=html}" paragraph and a "```" paragraph become raw HTML
local HTML_START, HTML_END = '```{=html}', '```'

local function paragraph_text(block)
  if block.t ~= 'Para' and block.t ~= 'Plain' then return nil end
  local text = pandoc.utils.stringify(block:walk({
    LineBreak = function() return pandoc.Str('\n') end,
    SoftBreak = function() return pandoc.Str('\n') end,
  }))
  -- Undo Word's smart quotes
  return (text:gsub('“', '"'):gsub('”', '"'):gsub('‘', "'"):gsub('’', "'"))
end

local function is_line(block, line)
  local text = paragraph_text(block)
  return text ~= nil and text:match('^%s*(.-)%s*$') == line
end

local function find_end(blocks, start)
  for i = start + 1, #blocks do
    if is_line(blocks[i], HTML_END) then return i end
    if not paragraph_text(blocks[i]) then return nil end
  end
  return nil
end

function Blocks(blocks)
  local result = pandoc.Blocks({})
  local i = 1
  while i <= #blocks do
    local last = is_line(blocks[i], HTML_START) and find_end(blocks, i)
    if last then
      -- A blank line would end the Markdown HTML block
      local lines = {}
      for j = i + 1, last - 1 do
        for line in paragraph_text(blocks[j]):gmatch('[^\n]*%S[^\n]*') do table.insert(lines, line) end
      end
      result:insert(pandoc.RawBlock('html', table.concat(lines, '\n')))
      i = last + 1
    else
      result:insert(blocks[i])
      i = i + 1
    end
  end
  return result
end
