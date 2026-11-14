library(shiny)
ui <- fluidPage(numericInput("n", "n", 10), plotOutput("p"))
server <- function(input, output, session) {
  output$p <- renderPlot(hist(rnorm(input$n)))
}
shinyApp(ui, server)
