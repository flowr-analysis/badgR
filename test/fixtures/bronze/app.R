library(shiny)
library(glue)
server <- function(input, output, session) {
  output$t <- renderText(glue(input$template))
}
