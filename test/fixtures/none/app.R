library(shiny)
server <- function(input, output, session) {
  observeEvent(input$go, {
    system(paste("convert", input$args))
  })
}
