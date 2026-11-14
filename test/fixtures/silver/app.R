library(shiny)
version <- system("git rev-parse HEAD", intern = TRUE)
server <- function(input, output, session) {
  output$v <- renderText(version)
}
