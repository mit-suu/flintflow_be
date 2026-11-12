# Screens imported with an original picture

Code loads this reference into the screen-layout prompt **only** when the input has `original_images[]`.

## Extra input

`mode` (`system` | `original`) and `original_images[]` (`index`, `caption`, `context`: the text right before /
after the picture). In mode `original` the pictures themselves are attached, in the same order as
`original_images`.

## Mode `original` (picture attached)

Copy the **layout** of the picture: number of field columns, order of blocks, label above / beside the input,
position and kind of buttons (solid = `primary`), nav present or not, popup, tabs; reuse the words you can read
in the picture. The spec must still cover every function and validation of the input: anything missing in
the picture goes at the end. Put **no colour** in the spec; report the dominant brand colour of the header /
main buttons as `primary_color` (`#RRGGBB`). Mode `system`: lay the screen out by the rules above, ignore how
the original looks.

## Which pictures are screens

Return `screen_images`: the `index` of every picture that shows this screen's UI (screenshot, mockup,
wireframe, prototype), judged from `caption` and `context` (and the picture itself in mode `original`). Use
cases, flow charts, ER and other diagrams are not screens. A section can have two screen pictures (web +
mobile): list both. None ⇒ `[]`.
